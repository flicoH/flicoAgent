import { Module } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import { DatabaseProvider } from '../../extend/database.provider';
import { ExtendModule } from '../../extend/extend.module';
import { TraceService } from '../trace/trace.service';
import { resolveTraceStorePath, resolveVectorStore } from './internal/load-store-config';
import { resolveMemoryPath } from '../memory/internal/load-memory-config';
import { FileTraceStore } from './reference/file-trace.store';
import { FileMemoryStore } from './reference/file-memory.store';
import { MEMORY_STORE, TRACE_STORE, VECTOR_STORE } from './store.interface';

/**
 * 存储模块 (StoreModule)
 *
 * 【职责】
 * 1. 绑定 `TRACE_STORE` 接口的默认实现（基于文件的原子存储 `FileTraceStore`）；
 * 2. 按配置绑定文件、MySQL、Qdrant 或业务提供的 `VECTOR_STORE`；
 * 3. 绑定 `MEMORY_STORE` 接口的默认实现（基于文件的会话记忆存储 `FileMemoryStore`）；
 * 4. 注入并注册 `TraceService` 旁路链路跟踪服务；
 * 5. 导出 `TRACE_STORE`, `VECTOR_STORE`, `MEMORY_STORE` 与 `TraceService` 供全局使用。
 */
@Module({
  imports: [ExtendModule],
  providers: [
    {
      provide: TRACE_STORE,
      // 使用工厂根据 ai.store.trace 配置动态创建 FileTraceStore 实例
      useFactory: (config: ConfigService) => (
        new FileTraceStore(resolveTraceStorePath(config))
      ),
      inject: [ConfigService],
    },
    {
      provide: VECTOR_STORE,
      useFactory: (config: ConfigService, database: DatabaseProvider) => resolveVectorStore(config, database.knex),
      inject: [ConfigService, DatabaseProvider],
    },
    {
      provide: MEMORY_STORE,
      // 使用工厂根据 ai.store.memory.path 配置动态创建 FileMemoryStore 实例
      useFactory: (config: ConfigService) => (
        new FileMemoryStore(resolveMemoryPath(config))
      ),
      inject: [ConfigService],
    },
    TraceService,
  ],
  exports: [TRACE_STORE, VECTOR_STORE, MEMORY_STORE, TraceService],
})
export class StoreModule {}
