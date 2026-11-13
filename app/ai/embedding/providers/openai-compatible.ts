/**
 * OpenAI 兼容的文本向量化提供者
 *
 * 【同构复用】
 * OpenAI 标准向量化接口（/v1/embeddings）与 DashScope 兼容模式（/compatible-mode/v1/embeddings）
 * 在请求体（model, input）与响应体（data[].embedding）协议结构上完全一致，
 * 因此复用 DashScopeCompatibleEmbeddingProvider 实现。
 */
export {
  DashScopeCompatibleEmbeddingConfig as OpenAiCompatibleEmbeddingConfig,
  DashScopeCompatibleEmbeddingProvider as OpenAiCompatibleEmbeddingProvider,
} from './dashscope-compatible';
