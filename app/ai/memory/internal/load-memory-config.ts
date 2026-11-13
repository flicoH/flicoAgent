import { resolve } from 'node:path';
import { ConfigService } from '../../../config/config.service';

/**
 * 根配置结构映射
 */
interface AiConfig {
  store?: {
    memory?: {
      path?: string;
      maxTurns?: number;
    } | string;
  };
  memory?: {
    path?: string;
    maxTurns?: number;
  };
}

/**
 * 解析 Memory 会话检查点存储目录的绝对物理路径
 *
 * 【解析优先级纪律】
 * 优先读取 `ai.store.memory.path`（若为对象读其 path 属性，若为字符串直接使用）；
 * 缺省回退至业务工程相对路径 `data/memory`。
 *
 * @param config 全局配置服务
 * @returns 会话记忆保存目录绝对路径
 */
export function resolveMemoryPath(config: ConfigService): string {
  const ai = config.get<AiConfig>('ai');

  // 1. 读 ai.store.memory.path 或 ai.store.memory
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

  // 2. 缺省读 ai.memory.path
  const directPath = ai?.memory?.path ?? config.get<string>('ai.memory.path');
  if (typeof directPath === 'string' && directPath.trim()) {
    return resolve(process.cwd(), directPath.trim());
  }

  // 3. 默认回退
  return resolve(process.cwd(), 'data/memory');
}

/**
 * 解析 Memory 会话滑动窗口最大保留消息条数 (maxTurns)
 *
 * 【约束规范】
 * 1. 从 `ai.store.memory.maxTurns` 读取；
 * 2. 缺省为 20；
 * 3. 非数字、NaN、无限大或 <= 0 时，一律安全回退到 20（禁止「没配就不截断」）；
 * 4. maxTurns 为单条消息条数计数（一条 user 或一条 assistant 各算 1）。
 *
 * @param config 全局配置服务
 * @returns 截断滑动窗口大小（固定正整数，默认 20）
 */
export function resolveMemoryMaxTurns(config: ConfigService): number {
  const ai = config.get<AiConfig>('ai');

  const configured = (ai?.store?.memory as any)?.maxTurns
    ?? config.get<unknown>('ai.store.memory.maxTurns')
    ?? ai?.memory?.maxTurns
    ?? config.get<unknown>('ai.memory.maxTurns');

  const val = Number(configured);
  if (Number.isFinite(val) && val > 0) {
    return Math.floor(val);
  }

  return 20;
}

/**
 * 解析是否启用多轮会话线程与 Checkpoint 记忆保持 (threadEnabled)
 *
 * 【解析优先级纪律】
 * 1. 优先读取 `agentConfig.threadEnabled`（对齐 agent 全局配置机制，支持 local/beta/prod 覆盖）；
 * 2. 次级读取 `ai.agentConfig.threadEnabled` 或 `ai.store.memory.threadEnabled`；
 * 3. 缺省返回 true（默认开启会话上下文保持）。
 *
 * @param config 全局配置服务
 * @returns 是否启用线程记忆
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

  const ai = config.get<AiConfig>('ai');
  const fromMemory = (ai?.store?.memory as any)?.threadEnabled
    ?? config.get<unknown>('ai.store.memory.threadEnabled');
  if (typeof fromMemory === 'boolean') {
    return fromMemory;
  }

  return true;
}

