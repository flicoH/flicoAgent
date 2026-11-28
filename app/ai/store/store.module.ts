import { Module } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import { DatabaseProvider } from '../../extend/database.provider';
import { ExtendModule } from '../../extend/extend.module';
import { TraceService } from '../trace/trace.service';
import {
  resolveMemoryStore,
  resolveTraceStore,
  resolveVectorStore,
} from './internal/load-store-config';
import { MEMORY_STORE, TRACE_STORE, VECTOR_STORE } from './store.interface';

/**
 * 存储模块 (StoreModule)
 *
 * 【职责】
 * 统一按配置装配 file / mysql / redis / use 工厂实现的 TRACE_STORE、VECTOR_STORE、MEMORY_STORE，
 * 并导出 TraceService 供运行时与控制器使用。
 */
@Module({
  imports: [ExtendModule],
  providers: [
    {
      provide: TRACE_STORE,
      useFactory: (config: ConfigService, database: DatabaseProvider) => resolveTraceStore(config, database.knex),
      inject: [ConfigService, DatabaseProvider],
    },
    {
      provide: VECTOR_STORE,
      useFactory: (config: ConfigService, database: DatabaseProvider) => resolveVectorStore(config, database.knex),
      inject: [ConfigService, DatabaseProvider],
    },
    {
      provide: MEMORY_STORE,
      useFactory: (config: ConfigService, database: DatabaseProvider) => resolveMemoryStore(config, database.knex),
      inject: [ConfigService, DatabaseProvider],
    },
    TraceService,
  ],
  exports: [TRACE_STORE, VECTOR_STORE, MEMORY_STORE, TraceService],
})
export class StoreModule {}
