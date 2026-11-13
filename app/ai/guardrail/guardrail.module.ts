import { Module } from '@nestjs/common';
import { GuardrailService } from './guardrail.service';

/**
 * 安全护栏守卫模块 (GuardrailModule)
 *
 * 【职责】
 * 封装 GuardrailService 并导出，供 RuntimeModule 及核心 AI 模块在 ReAct 循环前调用输入安全拦截。
 */
@Module({
  providers: [GuardrailService],
  exports: [GuardrailService],
})
export class GuardrailModule {}
