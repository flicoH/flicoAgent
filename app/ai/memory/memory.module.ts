import { Module } from '@nestjs/common';
import { StoreModule } from '../store/store.module';
import { CheckpointService } from './checkpoint.service';
import { ThreadService } from './thread.service';

/**
 * 记忆与上下文管理模块 (MemoryModule)
 *
 * 【职责】
 * 组装多轮长会话上下文 ThreadService 与状态快照 CheckpointService，
 * 并向外导出供 Runtime (OrchestratorService) 及 AI 根模块消费。
 */
@Module({
  imports: [StoreModule],
  providers: [ThreadService, CheckpointService],
  exports: [ThreadService, CheckpointService],
})
export class MemoryModule {}
