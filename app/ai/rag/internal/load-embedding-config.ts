import { ConfigService } from '../../../config/config.service';
import { OpenAIEmbeddings } from '@langchain/openai';
import type { EmbeddingProvider } from '../../contracts';

/**
 * 单个 Embedding 模型的配置项结构
 */
interface EmbeddingModelConfig {
  /** Provider 类型标识，内置通用实现为 'dashscope-compatible' 或 'openai-compatible' */
  provider?: string;
  /** API 根路径（例如 'https://dashscope.aliyuncs.com/compatible-mode/v1'） */
  baseURL?: string;
  /** 上游模型名称（例如 'text-embedding-v3' 等） */
  model?: string;
  /** 模型授权 API Key */
  apiKey?: string;
  /** 批量处理大小，默认 16 */
  batchSize?: number;
  /** 最大重试次数，默认 3 */
  maxRetries?: number;
  /** 业务自定义 Provider 扩展位：可直接传入 Provider 实例，或接收配置的构造函数 */
  use?: EmbeddingProvider | (new (config: EmbeddingModelConfig) => EmbeddingProvider);
}

/**
 * ai.embedding 节点配置契约
 */
interface EmbeddingConfig {
  /** 默认调用的向量模型 key，如 'text-embedding-v3' */
  default?: string;
  /** 已声明的模型字典表 */
  models?: Record<string, EmbeddingModelConfig>;
  /** 兼容直接在 ai.embedding 顶层声明的单一模型配置 */
  provider?: string;
  baseURL?: string;
  model?: string;
  apiKey?: string;
  use?: EmbeddingProvider | (new (config: EmbeddingModelConfig) => EmbeddingProvider);
}

/**
 * 根配置中与 AI 相关的配置节点
 */
interface AiConfig {
  embedding?: EmbeddingConfig;
}

/**
 * 解析并获取当前调用所需的向量化提供者 (EmbeddingProvider)
 *
 * 【同构解析流程】
 * 1. 优先读取全局配置 `ai.embedding`；
 * 2. 确定目标模型配置项（models[default] 或扁平配置）；
 * 3. 业务自定义 `use` 扩展位优先；
 * 4. 内置 Provider 支持校验（支持 'dashscope-compatible' / 'openai-compatible'）；
 * 5. 校验 apiKey、baseURL 与 model 完整性；
 * 6. 实例化并返回通用向量化提供者。
 *
 * @param configService 全局配置服务
 * @param requestedModel 可选的模型名称
 * @returns 解析得到的 EmbeddingProvider 实例
 */
export function resolveEmbedder(
  configService: ConfigService,
  requestedModel?: string,
): EmbeddingProvider {
  const embedding = configService.get<AiConfig>('ai')?.embedding
    ?? configService.get<EmbeddingConfig>('ai.embedding');

  if (!embedding) {
    throw new Error('ai.embedding is not configured');
  }

  // 确定模型配置：字典表或扁平声明
  const modelName = requestedModel ?? embedding.default;
  let modelConfig: EmbeddingModelConfig | undefined;

  if (embedding.models && modelName && embedding.models[modelName]) {
    modelConfig = embedding.models[modelName];
  } else if (embedding.baseURL || embedding.model || embedding.provider || embedding.use) {
    modelConfig = embedding as EmbeddingModelConfig;
  } else if (embedding.models) {
    const firstKey = Object.keys(embedding.models)[0];
    if (firstKey) {
      modelConfig = embedding.models[firstKey];
    }
  }

  if (!modelConfig) {
    throw new Error(`Embedding model "${modelName ?? 'default'}" is not configured in ai.embedding`);
  }

  // 1. 业务自定义扩展 Provider 优先
  if (modelConfig.use) {
    return typeof modelConfig.use === 'function'
      ? new modelConfig.use(modelConfig)
      : modelConfig.use;
  }

  // 2. 检查内置 Provider 支持情况
  const providerType = modelConfig.provider ?? 'dashscope-compatible';
  if (providerType !== 'dashscope-compatible' && providerType !== 'openai-compatible') {
    throw new Error(`Unsupported Embedding provider "${providerType}"`);
  }

  // 3. 获取并拦截占位符或未配置 Key（优先读取 embedding.models，支持从 llm.models 对应模型名称回退复用同一厂商 Key）
  const apiKey = (modelConfig.apiKey && modelConfig.apiKey !== 'xxxx')
    ? modelConfig.apiKey
    : configService.get<any>('ai')?.llm?.models?.[modelName ?? '']?.apiKey;

  if (!apiKey || apiKey === 'xxxx' || apiKey === 'sk-your-key-here') {
    throw new Error(`Embedding model "${modelName}" requires a non-placeholder apiKey in config.local.js (ai.embedding.models.${modelName}.apiKey or ai.llm.models.${modelName}.apiKey)`);
  }
  if (!modelConfig.baseURL || !modelConfig.model) {
    throw new Error(`Embedding model requires provider, baseURL, and model configuration`);
  }

  const embedder = new OpenAIEmbeddings({
    configuration: { baseURL: modelConfig.baseURL.replace(/\/+$/, '') },
    model: modelConfig.model,
    apiKey,
    batchSize: modelConfig.batchSize ?? 16,
    maxRetries: modelConfig.maxRetries ?? 3,
    stripNewLines: false,
  });
  return { embed: texts => embedder.embedDocuments(texts) };
}
