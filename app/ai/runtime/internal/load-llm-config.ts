import { ChatOpenAI } from '@langchain/openai';
import type { ConfigService } from '../../../config/config.service';
import type { LlmProvider } from '../../contracts';

/**
 * 单个 LLM 模型的配置项结构
 */
interface LlmModelConfig {
  /** Provider 类型标识，内置通用实现为 'openai-compatible' */
  provider?: string;
  /** API 根路径（例如 'https://dashscope.aliyuncs.com/compatible-mode/v1'），不包含 '/chat/completions' */
  baseURL?: string;
  /** 上游模型名称（例如 'qwen-plus', 'gpt-4o' 等） */
  model?: string;
  /** 模型授权 API Key，由各环境配置（config.local.js, config.prod.js）覆盖 */
  apiKey?: string;
  /** 业务自定义 Provider 扩展位：可直接传入 Provider 实例，或接收配置的构造函数 */
  use?: LlmProvider | (new (config: LlmModelConfig) => LlmProvider);
}

/**
 * ai.llm 节点配置契约
 */
interface LlmConfig {
  /** 默认调用的模型 key，如 'qwen' */
  default?: string;
  /** 已声明的模型字典表 */
  models?: Record<string, LlmModelConfig>;
}

/**
 * 根配置中与 ai 相关的配置节点
 */
interface AiConfig {
  llm?: LlmConfig;
}

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

export function resolveLlm(
  configService: ConfigService,
  modelName?: string,
): { kind: 'langchain'; model: ChatOpenAI } | { kind: 'custom'; provider: LlmProvider } {
  const llm = configService.get<AiConfig>('ai')?.llm
    ?? configService.get<LlmConfig>('ai.llm');
  const selectedModel = modelName ?? llm?.default;
  if (!selectedModel) {
    throw new Error('ai.llm.default is not configured');
  }

  const modelConfig = llm?.models?.[selectedModel];
  if (!modelConfig) {
    throw new Error(`LLM model "${selectedModel}" is not configured in ai.llm.models`);
  }

  if (modelConfig.use) {
    const provider = typeof modelConfig.use === 'function'
      ? new modelConfig.use(modelConfig)
      : modelConfig.use;
    return { kind: 'custom', provider };
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
    model: new ChatOpenAI({
      apiKey: resolved.apiKey,
      model: resolved.model,
      configuration: resolved.baseURL ? { baseURL: resolved.baseURL.replace(/\/+$/, '') } : undefined,
      temperature: 0,
      maxRetries: 2,
    }),
  };
}
