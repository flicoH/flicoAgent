import { Module } from '@nestjs/common';
import { EmbeddingModule } from '../embedding/embedding.module';
import { StoreModule } from '../store/store.module';
import { Chunker } from './chunker';
import { RetrieverService } from './retriever.service';

/**
 * 检索增强生成模块 (RagModule)
 *
 * 【职责】
 * 组装文档分块 (Chunker) 与知识库检索服务 (RetrieverService)，
 * 依赖底层 StoreModule (VectorStore) 与 EmbeddingModule (EmbeddingGateway)。
 */
@Module({
  imports: [StoreModule, EmbeddingModule],
  providers: [Chunker, RetrieverService],
  exports: [Chunker, RetrieverService],
})
export class RagModule {}
