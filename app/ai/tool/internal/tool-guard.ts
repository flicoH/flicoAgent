export class CapabilityTimeoutError extends Error {
  readonly code = 'TOOL_TIMEOUT';

  constructor(
    readonly capabilityName: string,
    readonly timeoutMs: number,
  ) {
    super(`Capability "${capabilityName}" timed out after ${timeoutMs}ms`);
    this.name = 'CapabilityTimeoutError';
  }
}

export interface TruncatedOutputEnvelope {
  truncated: true;
  originalChars: number;
  maxOutputChars: number;
  preview: string;
}

export interface TruncateToolOutputResult {
  output: unknown;
  truncated: boolean;
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function isCallerAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }
  return error instanceof Error && (
    error.name === 'AbortError'
    || (error as { code?: string }).code === 'ABORT_ERR'
  );
}

/**
 * 为工具/技能执行提供超时守卫与父级 AbortSignal 级联传播。
 * - 若父级 signal 已中止或执行期间中止，原样抛出 AbortError；
 * - 若达到 timeoutMs 仍未完成，中止子信号并抛出 CapabilityTimeoutError；
 * - 始终清理定时器与事件监听器，并吞掉迟到的拒绝避免 UnhandledPromiseRejection。
 */
export async function executeWithTimeout<T>(
  capabilityName: string,
  task: (signal?: AbortSignal) => Promise<T>,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const { timeoutMs, signal: parentSignal } = options;
  if (parentSignal?.aborted) {
    throw createAbortError(`Capability "${capabilityName}" execution aborted`);
  }

  const hasTimeout = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0;
  if (!hasTimeout) {
    return task(parentSignal);
  }

  const controller = new AbortController();
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  let onParentAbort: (() => void) | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const err = new CapabilityTimeoutError(capabilityName, timeoutMs);
      controller.abort(err);
      reject(err);
    }, timeoutMs);
    timer.unref?.();
  });

  let abortPromise: Promise<never> | undefined;
  if (parentSignal) {
    abortPromise = new Promise<never>((_resolve, reject) => {
      onParentAbort = () => {
        controller.abort(parentSignal.reason);
        reject(createAbortError(`Capability "${capabilityName}" execution aborted`));
      };
      if (parentSignal.aborted) {
        onParentAbort();
      } else {
        parentSignal.addEventListener('abort', onParentAbort, { once: true });
      }
    });
  }

  const taskPromise = Promise.resolve().then(() => task(controller.signal));
  taskPromise.catch(() => undefined);

  try {
    const racers: Promise<T>[] = [taskPromise, timeoutPromise];
    if (abortPromise) {
      racers.push(abortPromise);
    }
    return await Promise.race(racers);
  } catch (error) {
    if (parentSignal?.aborted) {
      throw createAbortError(`Capability "${capabilityName}" execution aborted`);
    }
    if (timedOut) {
      throw new CapabilityTimeoutError(capabilityName, timeoutMs);
    }
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (parentSignal && onParentAbort) {
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  }
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(value, (_key, current) => {
      if (typeof current === 'bigint') {
        return current.toString();
      }
      if (current && typeof current === 'object') {
        if (seen.has(current)) {
          return '[Circular]';
        }
        seen.add(current);
      }
      return current;
    });
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

/**
 * 对超大工具输出执行截断保护，避免撑爆 LLM 上下文或持久化 Trace。
 */
export function truncateToolOutput(output: unknown, maxOutputChars?: number): TruncateToolOutputResult {
  if (
    output === undefined
    || output === null
    || typeof maxOutputChars !== 'number'
    || !Number.isFinite(maxOutputChars)
    || maxOutputChars <= 0
  ) {
    return { output, truncated: false };
  }

  const limit = Math.floor(maxOutputChars);

  if (typeof output === 'string') {
    if (output.length <= limit) {
      return { output, truncated: false };
    }
    return {
      output: `${output.slice(0, limit)}\n...[truncated: ${output.length} chars total, limit ${limit}]`,
      truncated: true,
    };
  }

  const serialized = safeJsonStringify(output);
  if (serialized.length <= limit) {
    return { output, truncated: false };
  }

  const envelope: TruncatedOutputEnvelope = {
    truncated: true,
    originalChars: serialized.length,
    maxOutputChars: limit,
    preview: serialized.slice(0, limit),
  };
  return { output: envelope, truncated: true };
}
