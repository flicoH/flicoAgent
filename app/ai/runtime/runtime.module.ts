import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { GuardrailModule } from '../guardrail/guardrail.module';
import { MemoryModule } from '../memory/memory.module';
import { SkillModule } from '../skill/skill.module';
import { StoreModule } from '../store/store.module';
import { ToolModule } from '../tool/tool.module';
import { LangChainPlannerService } from './langchain/langchain-planner.service';
import { LangGraphOrchestratorService } from './langgraph/langgraph-orchestrator.service';

/**
 * LangChain / LangGraph 生产运行时模块 (RuntimeModule)
 *
 * 【职责】
 * 组装基于 LangChain (Planner) 与 LangGraph (Orchestrator) 的 Agent 生产运行时：
 * 注入 ToolModule 导出的执行器，组装规划与编排服务。
 */
@Module({
  imports: [
    AgentModule,
    SkillModule,
    ToolModule,
    StoreModule,
    MemoryModule,
    GuardrailModule,
  ],
  providers: [
    LangChainPlannerService,
    LangGraphOrchestratorService,
  ],
  exports: [LangGraphOrchestratorService],
})
export class RuntimeModule {}
