import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { GuardrailModule } from '../guardrail/guardrail.module';
import { LlmModule } from '../llm/llm.module';
import { MemoryModule } from '../memory/memory.module';
import { SkillModule } from '../skill/skill.module';
import { StoreModule } from '../store/store.module';
import { ToolModule } from '../tool/tool.module';
import { ExecutorService } from './executor.service';
import { OrchestratorService } from './orchestrator.service';
import { PlannerService } from './planner.service';

/**
 * 运行时编排模块 (RuntimeModule)
 *
 * 【职责】
 * 组装 Agent ReAct 编排运行环境：
 * 1. 导入基础设施模块：LlmModule（模型调用）、StoreModule（状态追踪）、MemoryModule（多轮上下文与检查点）、GuardrailModule（安全护栏）；
 * 2. 导入能力与声明模块：SkillModule（业务能力）、ToolModule（通用工具）、AgentModule（Agent 声明）；
 * 3. 内部注册 PlannerService、ExecutorService、OrchestratorService；
 * 4. 导出 OrchestratorService 作为外界运行 Agent 的唯一入口。
 */
@Module({
  imports: [LlmModule, SkillModule, ToolModule, AgentModule, StoreModule, MemoryModule, GuardrailModule],
  providers: [PlannerService, ExecutorService, OrchestratorService],
  exports: [OrchestratorService],
})
export class RuntimeModule {}
