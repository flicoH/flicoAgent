/**
 * 文档切片实体 (Chunk)
 */
export interface Chunk {
  /** 切片文本内容 */
  text: string;
  /** 附加元数据（如位置索引、文件来源等） */
  meta?: Record<string, unknown>;
}

/**
 * 文档切分器契约 (Chunker)
 *
 * 业务侧可通过 ai.rag.chunker.use 注入自定义切分实现
 */
export interface Chunker {
  /**
   * 将给定长文本切分为 Chunk 片段数组
   *
   * @param text 输入全文
   * @param meta 基础元数据
   */
  chunk(text: string, meta?: Record<string, unknown>): Chunk[];
}

/**
 * RAG 检索增强可配置选项 (RagOptions)
 */
export interface RagOptions {
  /** 文本切分参数 */
  chunk?: {
    /** 单个分块最大字符数，默认 500 */
    size?: number;
    /** 分块滑动窗口重叠字符数，默认 50 */
    overlap?: number;
  };
  /** 检索返回的 TopK 结果数量，默认 3 */
  topK?: number;
  /** 内置 retrieve 工具配置 */
  tool?: {
    /** 工具名称，默认 'retrieve' */
    name?: string;
    /** 工具功能描述 */
    description?: string;
  };
  /** 业务自定义切分器注入位 */
  chunker?: {
    use?: Chunker | (new (options?: unknown) => Chunker);
  };
}
