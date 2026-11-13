import { Module } from '@nestjs/common';
import { StoreModule } from '../store/store.module';
import { Chunker } from './chunker';
import { RetrieverService } from './retriever.service';

/**
 * 检索增强生成模块 (RagModule)
 *
 * 【职责】
 * 组装文档分块 (Chunker) 与知识库检索服务 (RetrieverService)，
 * 依赖底层 StoreModule (VectorStore)。
 */
@Module({
  imports: [StoreModule],
  providers: [Chunker, RetrieverService],
  exports: [Chunker, RetrieverService],
})
export class RagModule {}
