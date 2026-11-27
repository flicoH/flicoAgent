import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { GuardrailModule } from '../guardrail/guardrail.module';
import { MemoryModule } from '../memory/memory.module';
import { SkillModule } from '../skill/skill.module';
import { StoreModule } from '../store/store.module';
import { ToolModule } from '../tool/tool.module';
import { LlmCircuitBreakerService } from './internal/llm-circuit-breaker';
import { LangChainPlannerService } from './langchain/langchain-planner.service';
import { LangGraphOrchestratorService } from './langgraph/langgraph-orchestrator.service';

/**
 * LangChain / LangGraph 生产运行时模块 (RuntimeModule)
 *
 * 【职责】
 * 组装基于 LangChain (Planner) 与 LangGraph (Orchestrator) 的 Agent 生产运行时：
 * 1. 导入各依赖子模块：AgentModule, SkillModule, ToolModule, StoreModule, MemoryModule, GuardrailModule；
 * 2. 内部注册 LlmCircuitBreakerService, LangChainPlannerService, LangGraphOrchestratorService；
 * 3. 导出 LangGraphOrchestratorService、LangChainPlannerService 与 LlmCircuitBreakerService。
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
    LlmCircuitBreakerService,
    LangChainPlannerService,
    LangGraphOrchestratorService,
  ],
  exports: [
    LangGraphOrchestratorService,
    LangChainPlannerService,
    LlmCircuitBreakerService,
  ],
})
export class RuntimeModule {}
