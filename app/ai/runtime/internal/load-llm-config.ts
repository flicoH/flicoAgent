import { ConfigService } from '../../../config/config.service';
import { BadRequestException } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import type { LlmProvider } from '../../contracts';

/**
 * 单个 LLM 模型的配置项结构
 */
interface LlmModelConfig {
  /** 仅对支持 stream_options.include_usage 的上游开启。 */
  streamUsage?: boolean;
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

export function resolveLlm(
  configService: ConfigService,
  requestedModel?: string,
): { kind: 'langchain'; model: ChatOpenAI } | { kind: 'custom'; provider: LlmProvider } {
  const llm = configService.get<AiConfig>('ai')?.llm ?? configService.get<LlmConfig>('ai.llm');
  const modelName = requestedModel ?? llm?.default;

  if (!modelName) {
    throw new Error('ai.llm.default is not configured');
  }

  const modelConfig = llm?.models && Object.hasOwn(llm.models, modelName) ? llm.models[modelName] : undefined;
  if (!modelConfig) {
    if (requestedModel) throw new BadRequestException('Unknown model');
    throw new Error(`LLM model "${modelName}" is not configured in ai.llm.models`);
  }

  // 1. 业务自定义扩展 Provider 优先
  if (modelConfig.use) {
    const provider = typeof modelConfig.use === 'function'
      ? new modelConfig.use(modelConfig)
      : modelConfig.use;
    return { kind: 'custom', provider };
  }

  // 2. 检查内置 Provider 支持情况
  if (modelConfig.provider !== 'openai-compatible') {
    throw new Error(`Unsupported LLM provider "${modelConfig.provider ?? ''}" for model "${modelName}"`);
  }

  // 3. 拦截占位符或未配置 Key，在请求发出前及时预警
  if (!modelConfig.apiKey || modelConfig.apiKey === 'xxxx') {
    throw new Error(`LLM model "${modelName}" requires a non-placeholder apiKey at ai.llm.models.${modelName}.apiKey`);
  }
  if (!modelConfig.baseURL || !modelConfig.model) {
    throw new Error(`LLM model "${modelName}" requires provider, baseURL, and model configuration`);
  }

  return {
    kind: 'langchain',
    model: new ChatOpenAI({
      apiKey: modelConfig.apiKey,
      model: modelConfig.model,
      configuration: { baseURL: modelConfig.baseURL.replace(/\/+$/, '') },
      temperature: 0,
      maxRetries: 2,
    }),
  };
}
