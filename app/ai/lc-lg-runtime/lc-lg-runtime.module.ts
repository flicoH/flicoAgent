import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { GuardrailModule } from '../guardrail/guardrail.module';
import { LlmModule } from '../llm/llm.module';
import { MemoryModule } from '../memory/memory.module';
import { ExecutorService } from '../runtime/executor.service';
import { SkillModule } from '../skill/skill.module';
import { StoreModule } from '../store/store.module';
import { ToolModule } from '../tool/tool.module';
import { LangChainPlannerService } from './langchain/langchain-planner.service';
import { LangGraphOrchestratorService } from './langgraph/langgraph-orchestrator.service';

/**
 * LangChain / LangGraph 生产运行时模块 (LcLgRuntimeModule)
 *
 * 【职责】
 * 组装基于 LangChain (Planner) 与 LangGraph (Orchestrator) 的 Agent 生产运行时：
 * 1. 导入各依赖子模块：AgentModule, SkillModule, ToolModule, StoreModule, MemoryModule, GuardrailModule, LlmModule；
 * 2. 内部注册 LangChainPlannerService, LangGraphOrchestratorService, 以及当前模块专用的 ExecutorService；
 * 3. 仅导出 LangGraphOrchestratorService（避免 ExecutorService 与 RuntimeModule 冲突）。
 */
@Module({
  imports: [
    AgentModule,
    SkillModule,
    ToolModule,
    StoreModule,
    MemoryModule,
    GuardrailModule,
    LlmModule,
  ],
  providers: [
    LangChainPlannerService,
    LangGraphOrchestratorService,
    ExecutorService,
  ],
  exports: [LangGraphOrchestratorService],
})
export class LcLgRuntimeModule {}
