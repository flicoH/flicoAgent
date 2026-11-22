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

export type RagMode = 'rag' | 'wiki' | 'hybrid';

export type RagSourceDriver = 'file' | 'mysql';

export interface RagSourceOptions {
  /** 原文来源驱动，默认 'file' */
  driver?: RagSourceDriver;
  /** MySQL 原文表 flico_rag_documents 中的集合名 */
  collection?: string;
}

/**
 * RAG 检索增强可配置选项 (RagOptions)
 */
export interface RagOptions {
  mode?: RagMode;
  wiki?: {
    /** ai.llm.models 中用于编译 Wiki 的模型，默认使用 ai.llm.default。 */
    model?: string;
  };
  /** 原文来源配置 */
  source?: RagSourceOptions;
  /** 本地原文目录配置（当 ai.store.vector.fixturesPath 未配置时使用） */
  fixtures?: {
    path?: string;
  };
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
