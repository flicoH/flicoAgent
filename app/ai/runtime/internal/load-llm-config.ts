import { ChatOpenAI } from '@langchain/openai';
import type {
  LlmCircuitBreakerOptions,
  LlmGenerationOptions,
  LlmModelOptions,
  LlmOptions,
} from '../../../config/bootstrap-options';
import type { ConfigService } from '../../../config/config.service';
import type { LlmProvider } from '../../contracts';

/**
 * 根配置中与 ai 相关的配置节点
 */
interface AiConfig {
  llm?: LlmOptions;
}

/**
 * 归一化后的单次模型调用推理参数
 */
export interface ResolvedLlmParams {
  temperature: number;
  maxTokens?: number;
  topP?: number;
  timeoutMs?: number;
  maxRetries: number;
}

/**
 * 单次调用或 Agent 级别的推理参数覆盖项
 */
export interface ResolveLlmOverrides extends LlmGenerationOptions {
  /** 存在可用备模型时，未显式设置 maxRetries 将默认取 0 以加速切备 */
  hasFallbacks?: boolean;
}

/**
 * 归一化后的熔断器策略
 */
export interface ResolvedCircuitBreakerPolicy {
  enabled: boolean;
  failureThreshold: number;
  cooldownMs: number;
  halfOpenMaxCalls: number;
}

export type ResolvedLlm =
  | { kind: 'langchain'; modelKey: string; model: ChatOpenAI; params: ResolvedLlmParams }
  | { kind: 'custom'; modelKey: string; provider: LlmProvider; params: ResolvedLlmParams };

const DEFAULT_TEMPERATURE = 0;
const DEFAULT_MAX_RETRIES_SINGLE = 2;
const DEFAULT_MAX_RETRIES_WITH_FALLBACK = 0;
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 3;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 30_000;
const DEFAULT_CIRCUIT_HALF_OPEN_MAX_CALLS = 1;

/**
 * 常用国内/主流大模型提供商的默认 OpenAI-compatible 端点及模型名映射
 */
const KNOWN_MODEL_DEFAULTS: Record<string, { baseURL: string; model: string }> = {
  kimi: {
    baseURL: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2.6',
  },
  moonshot: {
    baseURL: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2.6',
  },
  qwen: {
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  },
  deepseek: {
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
};

export function readLlmConfig(configService: ConfigService): LlmOptions | undefined {
  return configService.get<AiConfig>('ai')?.llm
    ?? configService.get<LlmOptions>('ai.llm');
}

function validateTemperature(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('Invalid LLM temperature: must be a non-negative finite number');
  }
  return value;
}

function validatePositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid LLM ${field}: must be a positive integer`);
  }
  return value;
}

function validateNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid LLM ${field}: must be a non-negative integer`);
  }
  return value;
}

function validateTopP(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error('Invalid LLM topP: must be a finite number in (0, 1]');
  }
  return value;
}

function resolveTimeoutValue(source?: LlmGenerationOptions): unknown {
  if (!source) return undefined;
  return source.timeoutMs !== undefined ? source.timeoutMs : source.timeout;
}

/**
 * 按「调用/Agent 覆盖 → 单模型配置 → 全局 ai.llm → 内置默认值」合并并校验推理参数
 */
export function resolveLlmParams(
  llmConfig?: LlmOptions,
  modelConfig?: LlmModelOptions,
  overrides?: ResolveLlmOverrides,
): ResolvedLlmParams {
  const rawTemp = overrides?.temperature ?? modelConfig?.temperature ?? llmConfig?.temperature;
  const temperature = rawTemp === undefined ? DEFAULT_TEMPERATURE : validateTemperature(rawTemp);

  const rawMaxTokens = overrides?.maxTokens ?? modelConfig?.maxTokens ?? llmConfig?.maxTokens;
  const maxTokens = rawMaxTokens === undefined ? undefined : validatePositiveInt(rawMaxTokens, 'maxTokens');

  const rawTopP = overrides?.topP ?? modelConfig?.topP ?? llmConfig?.topP;
  const topP = rawTopP === undefined ? undefined : validateTopP(rawTopP);

  const rawTimeout = resolveTimeoutValue(overrides)
    ?? resolveTimeoutValue(modelConfig)
    ?? resolveTimeoutValue(llmConfig);
  const timeoutMs = rawTimeout === undefined ? undefined : validatePositiveInt(rawTimeout, 'timeoutMs');

  const rawMaxRetries = overrides?.maxRetries ?? modelConfig?.maxRetries ?? llmConfig?.maxRetries;
  const defaultRetries = overrides?.hasFallbacks
    ? DEFAULT_MAX_RETRIES_WITH_FALLBACK
    : DEFAULT_MAX_RETRIES_SINGLE;
  const maxRetries = rawMaxRetries === undefined
    ? defaultRetries
    : validateNonNegativeInt(rawMaxRetries, 'maxRetries');

  return {
    temperature,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    maxRetries,
  };
}

/**
 * 解析并去重候选模型链：[primary, ...extraFallbacks, ...model.fallbacks, ...global.fallbacks]
 */
export function resolveLlmCandidates(
  configService: ConfigService,
  modelName?: string,
  extraFallbacks?: readonly string[],
): { primary: string; candidates: string[] } {
  const llm = readLlmConfig(configService);
  const primary = (typeof modelName === 'string' && modelName.trim())
    ? modelName.trim()
    : (typeof llm?.default === 'string' && llm.default.trim() ? llm.default.trim() : undefined);

  if (!primary) {
    throw new Error('ai.llm.default is not configured');
  }

  const primaryConfig = llm?.models?.[primary];
  if (!primaryConfig) {
    throw new Error(`LLM model "${primary}" is not configured in ai.llm.models`);
  }

  const candidates: string[] = [primary];
  const seen = new Set<string>([primary]);

  const sources: Array<readonly string[] | undefined> = [
    extraFallbacks,
    primaryConfig.fallbacks,
    llm?.fallbacks,
  ];

  for (const list of sources) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      throw new Error('LLM fallbacks must be an array of model keys');
    }
    for (const rawKey of list) {
      if (typeof rawKey !== 'string' || !rawKey.trim()) {
        throw new Error('LLM fallback model key must be a non-empty string');
      }
      const key = rawKey.trim();
      if (!llm?.models?.[key]) {
        throw new Error(`LLM fallback model "${key}" is not configured in ai.llm.models`);
      }
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(key);
      }
    }
  }

  return { primary, candidates };
}

/**
 * 解析模型级熔断器策略
 *
 * 启用纪律：
 * - 若显式配置 `ai.llm.circuitBreaker.enabled`，严格遵循该布尔值；
 * - 否则，当显式配置了 `ai.llm.circuitBreaker` 对象或存在备模型（hasFallbacks=true）时默认启用；
 * - 仅单模型且未配置 `circuitBreaker` 时默认关闭，保持既有单模型行为不变。
 */
export function resolveCircuitBreakerConfig(
  configService: ConfigService,
  hasFallbacks = false,
): ResolvedCircuitBreakerPolicy {
  const llm = readLlmConfig(configService);
  const cfg: LlmCircuitBreakerOptions | undefined = llm?.circuitBreaker;

  if (cfg !== undefined && (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg))) {
    throw new Error('Invalid ai.llm.circuitBreaker configuration');
  }

  const enabled = typeof cfg?.enabled === 'boolean'
    ? cfg.enabled
    : (cfg !== undefined || hasFallbacks);

  const failureThreshold = cfg?.failureThreshold === undefined
    ? DEFAULT_CIRCUIT_FAILURE_THRESHOLD
    : validatePositiveInt(cfg.failureThreshold, 'circuitBreaker.failureThreshold');

  const cooldownMs = cfg?.cooldownMs === undefined
    ? DEFAULT_CIRCUIT_COOLDOWN_MS
    : validatePositiveInt(cfg.cooldownMs, 'circuitBreaker.cooldownMs');

  const halfOpenMaxCalls = cfg?.halfOpenMaxCalls === undefined
    ? DEFAULT_CIRCUIT_HALF_OPEN_MAX_CALLS
    : validatePositiveInt(cfg.halfOpenMaxCalls, 'circuitBreaker.halfOpenMaxCalls');

  return {
    enabled,
    failureThreshold,
    cooldownMs,
    halfOpenMaxCalls,
  };
}

export function resolveLlm(
  configService: ConfigService,
  modelName?: string,
  overrides?: ResolveLlmOverrides,
): ResolvedLlm {
  const llm = readLlmConfig(configService);
  const selectedModel = modelName ?? llm?.default;
  if (!selectedModel) {
    throw new Error('ai.llm.default is not configured');
  }

  const modelConfig = llm?.models?.[selectedModel];
  if (!modelConfig) {
    throw new Error(`LLM model "${selectedModel}" is not configured in ai.llm.models`);
  }

  const params = resolveLlmParams(llm, modelConfig, overrides);

  if (modelConfig.use) {
    const provider = typeof modelConfig.use === 'function'
      ? new modelConfig.use(modelConfig)
      : modelConfig.use;
    return { kind: 'custom', modelKey: selectedModel, provider, params };
  }

  if (modelConfig.provider !== 'openai-compatible') {
    throw new Error(`Unsupported LLM provider "${modelConfig.provider ?? ''}" for model "${selectedModel}"`);
  }
  if (!modelConfig.apiKey || modelConfig.apiKey === 'xxxx') {
    throw new Error(`LLM model "${selectedModel}" requires a non-placeholder apiKey at ai.llm.models.${selectedModel}.apiKey`);
  }

  const defaults = KNOWN_MODEL_DEFAULTS[selectedModel.toLowerCase()];
  const resolved = {
    apiKey: modelConfig.apiKey,
    model: modelConfig.model ?? defaults?.model ?? selectedModel,
    baseURL: modelConfig.baseURL ?? defaults?.baseURL
      ?? process.env.OPENAI_BASE_URL ?? process.env.OPENAI_API_BASE,
  };

  return {
    kind: 'langchain',
    modelKey: selectedModel,
    params,
    model: new ChatOpenAI({
      apiKey: resolved.apiKey,
      model: resolved.model,
      configuration: resolved.baseURL ? { baseURL: resolved.baseURL.replace(/\/+$/, '') } : undefined,
      temperature: params.temperature,
      ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
      ...(params.topP !== undefined ? { topP: params.topP } : {}),
      ...(params.timeoutMs !== undefined ? { timeout: params.timeoutMs } : {}),
      maxRetries: params.maxRetries,
    }),
  };
}
