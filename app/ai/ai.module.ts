import { Module } from '@nestjs/common';
import { AgentModule } from './agent/agent.module';
import { AiController } from './ai.controller';
import { GuardrailModule } from './guardrail/guardrail.module';
import { McpModule } from './mcp/mcp.module';
import { MemoryModule } from './memory/memory.module';
import { RagController } from './rag/rag.controller';
import { RagModule } from './rag/rag.module';
import { RuntimeModule } from './runtime/runtime.module';
import { SkillModule } from './skill/skill.module';
import { StoreModule } from './store/store.module';
import { ToolModule } from './tool/tool.module';

/**
 * AI 核心聚合模块 (AiModule)
 *
 * 【架构职责】
 * 作为 elpis 框架 Agent Runtime Harness 的总装配入口：
 * 1. 聚合底层基础设施模块：
 *    - StoreModule: 状态持久化（Trace 链路存储）
 * 2. 聚合能力与资源声明模块：
 *    - SkillModule: 业务技能（Skill）的扫描、校验与注册
 *    - ToolModule: 通用工具（Tool）的注册表与内置检索工具
 *    - McpModule: 外部 MCP Server 适配与扩展
 *    - AgentModule: Agent 声明扫描与元数据管理
 * 3. 聚合运行时与高级模块：
 *    - RuntimeModule: ReAct 核心编排引擎（Planner、Executor、Orchestrator）
 *    - RagModule: 知识库检索增强生成相关
 *    - MemoryModule: 上下文记忆与 Checkpoint 状态管理
 * 4. 挂载控制器：
 *    - AiController 和 RagController: 暴露 `/api/ai/*` REST 与 SSE 端点
 */
@Module({
  imports: [
    // 注入存储能力（TraceStore 及 TraceService）
    StoreModule,
    // 注册业务 Skill
    SkillModule,
    // 注入 ToolRegistryService，使 Controller 可返回已注册工具列表
    ToolModule,
    // 注入 MCP (Model Context Protocol) 模块，支持外部工具生态接入
    McpModule,
    // 注入 AgentScannerService，使 Controller 可返回 Agent 纯声明列表
    AgentModule,
    // 注入 LangChain + LangGraph 运行时模块
    RuntimeModule,
    // 注入 RAG 检索增强模块
    RagModule,
    // 注入 Memory 会话与检查点记忆模块
    MemoryModule,
    // 注入安全护栏守卫模块
    GuardrailModule,
  ],
  controllers: [AiController, RagController],
})
export class AiModule {}
