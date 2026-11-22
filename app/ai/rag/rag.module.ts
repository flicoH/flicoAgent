import { Module } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import { DatabaseProvider } from '../../extend/database.provider';
import { ExtendModule } from '../../extend/extend.module';
import { StoreModule } from '../store/store.module';
import { Chunker } from './chunker';
import { RAG_SOURCE, resolveRagSource } from './rag-source';
import { RetrieverService } from './retriever.service';

/**
 * 检索增强生成模块 (RagModule)
 *
 * 【职责】
 * 组装文档分块 (Chunker) 与知识库检索服务 (RetrieverService)，
 * 依赖底层 StoreModule (VectorStore)。
 */
@Module({
  imports: [StoreModule, ExtendModule],
  providers: [
    {
      provide: RAG_SOURCE,
      useFactory: (config: ConfigService, database: DatabaseProvider) => resolveRagSource(config, database.knex),
      inject: [ConfigService, DatabaseProvider],
    },
    Chunker,
    RetrieverService,
  ],
  exports: [Chunker, RetrieverService],
})
export class RagModule {}
