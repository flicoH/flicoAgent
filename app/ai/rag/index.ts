/**
 * 检索增强生成 (RAG) 子系统导出入口
 *
 * 包含切片器契约、文本切片纯函数、知识库灌库与语义检索服务，以及 Nest 依赖注入模块。
 */
export type { Chunk, RagOptions } from './rag.interface';
export type { Chunker as IChunker } from './rag.interface';
export { chunk, resolveChunker, Chunker } from './chunker';
export * from './retriever.service';
export * from './rag.module';
