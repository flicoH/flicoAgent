import { Injectable } from '@nestjs/common';
import type { LlmCircuitState, LlmFallbackEvent, LlmFallbackReason } from '../../contracts';
import type { ResolvedCircuitBreakerPolicy } from './load-llm-config';

export interface LlmErrorClassification {
  retryable: boolean;
  reason?: LlmFallbackReason;
  code: string;
  statusCode?: number;
}

export interface LlmCircuitSnapshot {
  modelKey: string;
  state: LlmCircuitState;
  consecutiveFailures: number;
  openedAt?: number;
  nextAttemptAt?: number;
  halfOpenInFlight: number;
  lastErrorCode?: string;
}

export type CircuitAcquireResult =
  | { allowed: true; state: LlmCircuitState; isProbe: boolean }
  | { allowed: false; state: 'open' | 'half_open'; nextAttemptAt: number };

interface CircuitEntry {
  state: LlmCircuitState;
  consecutiveFailures: number;
  openedAt?: number;
  nextAttemptAt?: number;
  halfOpenInFlight: number;
  lastErrorCode?: string;
}

const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
]);

/**
 * 熔断开启导致无法发起模型调用时的专用异常
 */
export class LlmCircuitOpenError extends Error {
  readonly code = 'LLM_CIRCUIT_OPEN';
  readonly modelKey: string;
  readonly nextAttemptAt: number;

  constructor(modelKey: string, nextAttemptAt: number) {
    super(`LLM model "${modelKey}" circuit breaker is open`);
    this.name = 'LlmCircuitOpenError';
    this.modelKey = modelKey;
    this.nextAttemptAt = nextAttemptAt;
  }
}

function readStatusCode(err: Record<string, unknown>): number | undefined {
  const candidates = [
    err.status,
    err.statusCode,
    (err.response as Record<string, unknown> | undefined)?.status,
    (err.response as Record<string, unknown> | undefined)?.statusCode,
  ];
  for (const val of candidates) {
    if (typeof val === 'number' && Number.isInteger(val) && val >= 100 && val <= 599) {
      return val;
    }
  }
  return undefined;
}

/**
 * 识别上游模型调用异常是否属于瞬态可重试故障（429 / 5xx / 超时 / 网络中断）
 */
export function classifyLlmError(error: unknown, timedOut = false): LlmErrorClassification {
  if (timedOut) {
    return { retryable: true, reason: 'timeout', code: 'LLM_TIMEOUT' };
  }

  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const rec = current as Record<string, unknown>;
    const status = readStatusCode(rec);
    const code = typeof rec.code === 'string'
      ? rec.code.toUpperCase()
      : (typeof rec.errno === 'string' ? rec.errno.toUpperCase() : '');
    const name = typeof rec.name === 'string' ? rec.name : '';
    const message = typeof rec.message === 'string' ? rec.message : '';

    if (
      name === 'TimeoutError'
      || name === 'APIConnectionTimeoutError'
      || status === 408
      || TIMEOUT_CODES.has(code)
      || /\b(timed?\s*out|request timeout|timeout exceeded)\b/i.test(message)
    ) {
      return {
        retryable: true,
        reason: 'timeout',
        code: 'LLM_TIMEOUT',
        ...(status !== undefined ? { statusCode: status } : {}),
      };
    }

    if (status === 429 || name === 'RateLimitError') {
      return {
        retryable: true,
        reason: 'rate_limit',
        code: 'LLM_RATE_LIMITED',
        statusCode: 429,
      };
    }

    if (status !== undefined && status >= 500 && status <= 599) {
      return {
        retryable: true,
        reason: 'server_error',
        code: 'LLM_SERVER_ERROR',
        statusCode: status,
      };
    }

    if (status !== undefined && status >= 400 && status < 500) {
      return {
        retryable: false,
        code: 'LLM_CLIENT_ERROR',
        statusCode: status,
      };
    }

    if (
      NETWORK_CODES.has(code)
      || name === 'APIConnectionError'
      || /fetch failed|socket hang up|network error|connection reset|econnreset|econnrefused/i.test(message)
    ) {
      return {
        retryable: true,
        reason: 'network_error',
        code: 'LLM_NETWORK_ERROR',
      };
    }

    current = rec.cause;
  }

  return { retryable: false, code: 'LLM_NON_RETRYABLE' };
}

/**
 * 生成严格脱敏的切换说明文案（绝不包含 API Key、URL 或上游堆栈原文）
 */
export function sanitizeLlmFallbackMessage(event: LlmFallbackEvent): string {
  switch (event.reason) {
    case 'circuit_open':
      return `Model "${event.fromModel}" circuit is ${event.circuitState ?? 'open'}; switched to "${event.toModel}"`;
    case 'rate_limit':
      return `Model "${event.fromModel}" rate limited (HTTP 429); switched to "${event.toModel}"`;
    case 'server_error':
      return `Model "${event.fromModel}" failed with HTTP ${event.statusCode ?? '5xx'}; switched to "${event.toModel}"`;
    case 'timeout':
      return `Model "${event.fromModel}" timed out; switched to "${event.toModel}"`;
    case 'network_error':
      return `Model "${event.fromModel}" encountered a network error; switched to "${event.toModel}"`;
  }
}

/**
 * 模型级三态熔断器服务 (LlmCircuitBreakerService)
 *
 * 状态流转：
 * - closed -> open：连续可重试失败次数达到 failureThreshold
 * - open -> half_open：冷却时间 cooldownMs 到期
 * - half_open -> closed：探测请求成功
 * - half_open -> open：探测请求发生可重试失败
 */
@Injectable()
export class LlmCircuitBreakerService {
  private readonly entries = new Map<string, CircuitEntry>();
  private clock: () => number = () => Date.now();

  /** 替换时钟函数（供单元测试确定性推进冷却时间） */
  setClock(clock: () => number): void {
    this.clock = clock;
  }

  tryAcquire(modelKey: string, policy: ResolvedCircuitBreakerPolicy): CircuitAcquireResult {
    if (!policy.enabled) {
      return { allowed: true, state: 'closed', isProbe: false };
    }

    const entry = this.ensureEntry(modelKey);
    const now = this.clock();

    if (entry.state === 'open') {
      if (entry.nextAttemptAt !== undefined && now < entry.nextAttemptAt) {
        return { allowed: false, state: 'open', nextAttemptAt: entry.nextAttemptAt };
      }
      entry.state = 'half_open';
      entry.halfOpenInFlight = 0;
    }

    if (entry.state === 'half_open') {
      if (entry.halfOpenInFlight >= policy.halfOpenMaxCalls) {
        return {
          allowed: false,
          state: 'half_open',
          nextAttemptAt: entry.nextAttemptAt ?? (now + policy.cooldownMs),
        };
      }
      entry.halfOpenInFlight++;
      return { allowed: true, state: 'half_open', isProbe: true };
    }

    return { allowed: true, state: 'closed', isProbe: false };
  }

  recordSuccess(modelKey: string, isProbe: boolean): void {
    const entry = this.entries.get(modelKey);
    if (!entry) return;
    if (isProbe && entry.halfOpenInFlight > 0) {
      entry.halfOpenInFlight--;
    }
    entry.state = 'closed';
    entry.consecutiveFailures = 0;
    entry.openedAt = undefined;
    entry.nextAttemptAt = undefined;
    entry.halfOpenInFlight = 0;
    entry.lastErrorCode = undefined;
  }

  recordFailure(
    modelKey: string,
    policy: ResolvedCircuitBreakerPolicy,
    errorCode: string,
    isProbe: boolean,
  ): LlmCircuitState {
    if (!policy.enabled) {
      return 'closed';
    }

    const entry = this.ensureEntry(modelKey);
    const now = this.clock();
    entry.lastErrorCode = errorCode;

    if (isProbe) {
      entry.state = 'open';
      entry.consecutiveFailures = Math.max(entry.consecutiveFailures + 1, policy.failureThreshold);
      entry.openedAt = now;
      entry.nextAttemptAt = now + policy.cooldownMs;
      entry.halfOpenInFlight = 0;
      return entry.state;
    }

    entry.consecutiveFailures++;
    if (entry.consecutiveFailures >= policy.failureThreshold) {
      entry.state = 'open';
      entry.openedAt = now;
      entry.nextAttemptAt = now + policy.cooldownMs;
      entry.halfOpenInFlight = 0;
    }
    return entry.state;
  }

  /**
   * 调用方主动取消或遇到非瞬态 4xx 时释放半开探测槽位，不误触发熔断
   */
  releaseProbe(modelKey: string, isProbe: boolean): void {
    if (!isProbe) return;
    const entry = this.entries.get(modelKey);
    if (entry && entry.halfOpenInFlight > 0) {
      entry.halfOpenInFlight--;
    }
  }

  getState(modelKey: string): LlmCircuitSnapshot {
    const entry = this.entries.get(modelKey);
    if (!entry) {
      return {
        modelKey,
        state: 'closed',
        consecutiveFailures: 0,
        halfOpenInFlight: 0,
      };
    }

    const now = this.clock();
    const effectiveState: LlmCircuitState = (
      entry.state === 'open' && entry.nextAttemptAt !== undefined && now >= entry.nextAttemptAt
    ) ? 'half_open' : entry.state;

    return {
      modelKey,
      state: effectiveState,
      consecutiveFailures: entry.consecutiveFailures,
      ...(entry.openedAt !== undefined ? { openedAt: entry.openedAt } : {}),
      ...(entry.nextAttemptAt !== undefined ? { nextAttemptAt: entry.nextAttemptAt } : {}),
      halfOpenInFlight: entry.halfOpenInFlight,
      ...(entry.lastErrorCode ? { lastErrorCode: entry.lastErrorCode } : {}),
    };
  }

  getAllStates(): Record<string, LlmCircuitSnapshot> {
    const snapshots: Record<string, LlmCircuitSnapshot> = {};
    for (const key of this.entries.keys()) {
      snapshots[key] = this.getState(key);
    }
    return snapshots;
  }

  reset(modelKey?: string): void {
    if (modelKey !== undefined) {
      this.entries.delete(modelKey);
      return;
    }
    this.entries.clear();
  }

  private ensureEntry(modelKey: string): CircuitEntry {
    let entry = this.entries.get(modelKey);
    if (!entry) {
      entry = {
        state: 'closed',
        consecutiveFailures: 0,
        halfOpenInFlight: 0,
      };
      this.entries.set(modelKey, entry);
    }
    return entry;
  }
}
