import { Module } from '@nestjs/common';
import { LlmGateway } from './llm.gateway';

/**
 * 大模型能力模块 (LlmModule)
 *
 * 【职责】
 * 注册并导出大模型统一网关 `LlmGateway`。
 * 上层模块（如 RuntimeModule, AiController 等）只需依赖 LlmModule，
 * 无需关心具体的底层提供者实现与 API 规范。
 */
@Module({
  providers: [LlmGateway],
  exports: [LlmGateway],
})
export class LlmModule {}
