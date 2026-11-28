import { resolve } from 'node:path';
import type { MemorySummarizationOptions } from '../../../config/bootstrap-options';
import { ConfigService } from '../../../config/config.service';

export const DEFAULT_MEMORY_MAX_TURNS = 20;
export const DEFAULT_SUMMARY_TRIGGER_TOKENS = 4000;
export const DEFAULT_SUMMARY_KEEP_RECENT_MESSAGES = 6;
export const DEFAULT_SUMMARY_MAX_CHARS = 2000;

export interface ResolvedMemorySummarizationOptions {
  enabled: boolean;
  model?: string;
  triggerTokens: number;
  keepRecentMessages: number;
  maxSummaryChars: number;
}

interface MemoryConfigLike {
  path?: string;
  maxTurns?: number;
  maxContextTokens?: number;
  summarization?: MemorySummarizationOptions;
  threadEnabled?: boolean;
}

interface AiConfig {
  store?: {
    memory?: MemoryConfigLike | string;
  };
  memory?: MemoryConfigLike;
}

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

function readMemoryConfigSections(config?: ConfigService): {
  storeMemory?: MemoryConfigLike;
  directMemory?: MemoryConfigLike;
} {
  if (!config) {
    return {};
  }
  const ai = config.get<AiConfig>('ai');
  const rawStoreMem = ai?.store?.memory ?? config.get<unknown>('ai.store.memory');
  const storeMemory = rawStoreMem && typeof rawStoreMem === 'object' ? (rawStoreMem as MemoryConfigLike) : undefined;
  const rawDirectMem = ai?.memory ?? config.get<unknown>('ai.memory');
  const directMemory = rawDirectMem && typeof rawDirectMem === 'object' ? (rawDirectMem as MemoryConfigLike) : undefined;
  return { storeMemory, directMemory };
}

/**
 * 解析 Memory 会话检查点存储目录的绝对物理路径
 */
export function resolveMemoryPath(config: ConfigService): string {
  const ai = config.get<AiConfig>('ai');

  const memoryStore = ai?.store?.memory ?? config.get<unknown>('ai.store.memory');
  if (typeof memoryStore === 'string' && memoryStore.trim()) {
    return resolve(process.cwd(), memoryStore.trim());
  }
  if (memoryStore && typeof memoryStore === 'object') {
    const customPath = (memoryStore as { path?: unknown }).path;
    if (typeof customPath === 'string' && customPath.trim()) {
      return resolve(process.cwd(), customPath.trim());
    }
  }

  const directPath = ai?.memory?.path ?? config.get<string>('ai.memory.path');
  if (typeof directPath === 'string' && directPath.trim()) {
    return resolve(process.cwd(), directPath.trim());
  }

  return resolve(process.cwd(), 'data/memory');
}

/**
 * 解析 Memory 会话滑动窗口最大保留消息条数 (maxTurns)
 */
export function resolveMemoryMaxTurns(config?: ConfigService): number {
  if (!config) {
    return DEFAULT_MEMORY_MAX_TURNS;
  }
  const { storeMemory, directMemory } = readMemoryConfigSections(config);
  const configured = storeMemory?.maxTurns
    ?? config.get<unknown>('ai.store.memory.maxTurns')
    ?? directMemory?.maxTurns
    ?? config.get<unknown>('ai.memory.maxTurns');

  return parsePositiveInt(configured) ?? DEFAULT_MEMORY_MAX_TURNS;
}

/**
 * 解析历史上下文估算 Token 预算上限（未配置时返回 undefined，不启用 Token 预算裁剪）
 */
export function resolveMemoryMaxContextTokens(config?: ConfigService): number | undefined {
  if (!config) {
    return undefined;
  }
  const { storeMemory, directMemory } = readMemoryConfigSections(config);
  const configured = storeMemory?.maxContextTokens
    ?? config.get<unknown>('ai.store.memory.maxContextTokens')
    ?? directMemory?.maxContextTokens
    ?? config.get<unknown>('ai.memory.maxContextTokens');

  return parsePositiveInt(configured);
}

/**
 * 解析历史对话自动摘要压缩配置
 */
export function resolveMemorySummarizationOptions(config?: ConfigService): ResolvedMemorySummarizationOptions {
  const maxContextTokens = resolveMemoryMaxContextTokens(config);
  if (!config) {
    return {
      enabled: false,
      triggerTokens: maxContextTokens ?? DEFAULT_SUMMARY_TRIGGER_TOKENS,
      keepRecentMessages: DEFAULT_SUMMARY_KEEP_RECENT_MESSAGES,
      maxSummaryChars: DEFAULT_SUMMARY_MAX_CHARS,
    };
  }
  const { storeMemory, directMemory } = readMemoryConfigSections(config);
  const raw = (storeMemory?.summarization
    ?? config.get<MemorySummarizationOptions>('ai.store.memory.summarization')
    ?? directMemory?.summarization
    ?? config.get<MemorySummarizationOptions>('ai.memory.summarization')) as MemorySummarizationOptions | undefined;

  const model = typeof raw?.model === 'string' && raw.model.trim() ? raw.model.trim() : undefined;
  const triggerTokens = parsePositiveInt(raw?.triggerTokens)
    ?? maxContextTokens
    ?? DEFAULT_SUMMARY_TRIGGER_TOKENS;
  const keepRecentMessages = Math.max(
    2,
    parsePositiveInt(raw?.keepRecentMessages) ?? DEFAULT_SUMMARY_KEEP_RECENT_MESSAGES,
  );
  const maxSummaryChars = parsePositiveInt(raw?.maxSummaryChars) ?? DEFAULT_SUMMARY_MAX_CHARS;

  return {
    enabled: raw?.enabled === true,
    ...(model ? { model } : {}),
    triggerTokens,
    keepRecentMessages,
    maxSummaryChars,
  };
}

/**
 * 解析是否启用多轮会话线程与 Checkpoint 记忆保持 (threadEnabled)
 */
export function resolveThreadEnabled(config: ConfigService): boolean {
  const fromAgent = config.get<unknown>('agentConfig.threadEnabled');
  if (typeof fromAgent === 'boolean') {
    return fromAgent;
  }

  const fromAiAgent = config.get<unknown>('ai.agentConfig.threadEnabled');
  if (typeof fromAiAgent === 'boolean') {
    return fromAiAgent;
  }

  const { storeMemory, directMemory } = readMemoryConfigSections(config);
  const fromMemory = storeMemory?.threadEnabled
    ?? config.get<unknown>('ai.store.memory.threadEnabled')
    ?? directMemory?.threadEnabled
    ?? config.get<unknown>('ai.memory.threadEnabled');
  if (typeof fromMemory === 'boolean') {
    return fromMemory;
  }

  return true;
}
