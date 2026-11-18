import { Annotation } from '@langchain/langgraph';
import type { StructuredTool } from '@langchain/core/tools';
import type { LlmMessage } from '../../contracts';
import type { ExecutionResult, Step } from '../../contracts';
import type { LangChainToolCall } from '../langchain/langchain-planner.service';

/**
 * 携带 node 与 planner 观测字段的运行步骤实体 (GraphStep)
 *
 * 【设计说明】
 * 继承框架通用的 `Step` 合同：
 * 1. 扩展 `node`: 记录产生该步骤的图节点（'plan' | 'execute' | 'observe'）；
 * 2. 扩展 `planner`: 明确标注规划引擎（'langchain'）；
 * 3. 严格保持原始 Step 的字段名与核心语义不变更，兼容 Trace 与前端展示。
 */
export interface GraphStep extends Step {
  /** 产生该步骤的 LangGraph 节点标识 */
  node?: 'plan' | 'execute' | 'observe';
  /** 规划器类型标识，固定为 'langchain' */
  planner?: 'langchain';
  /** 允许携带其他元数据键值 */
  [key: string]: unknown;
}

/**
 * LangGraph 循环状态注解定义 (AgentStateAnnotation)
 *
 * 【状态图通道设计规范】
 * - `messages`: 包含多轮对话历史。reducer 优先采用新覆盖数组；
 * - `iteration`: 轮次计数器。每次进入 plan 节点递增；
 * - `maxIterations`: 最大循环上限。读取全局配置服务注入，禁止写死 5；
 * - `tools`: 当前 Agent 经白名单筛选后的 LangChain StructuredTool 集合；
 * - `toolCalls`: 规划器在当前轮次决策出的工具调用列表；
 * - `executionResult`: 执行器在 execute 节点产生的单次执行结果；
 * - `finalAnswer`: 最终文本答复。非空时触发条件边流转至 END 退出循环；
 * - `isMaxIterationError`: 标识是否因达到最大轮次而安全熔断；
 * - `steps`: 聚合全流程产生的所有执行步骤，reducer 自动按序拼接。
 */
export const AgentStateAnnotation = Annotation.Root({
  // 当前多轮消息历史
  messages: Annotation<LlmMessage[]>({
    reducer: (x, y) => y ?? x,
    default: () => [],
  }),
  // 当前循环迭代轮次计数
  iteration: Annotation<number>({
    reducer: (x, y) => (y !== undefined ? y : x),
    default: () => 0,
  }),
  // 最大迭代上限（由 resolveMaxIterations 提供，禁止写死 5）
  maxIterations: Annotation<number>({
    reducer: (x, y) => (y !== undefined ? y : x),
    default: () => 5,
  }),
  // 开放给当前 Agent 的 StructuredTool 集合
  tools: Annotation<StructuredTool[]>({
    reducer: (x, y) => y ?? x,
    default: () => [],
  }),
  // 规划器产出的工具调用指令
  toolCalls: Annotation<LangChainToolCall[] | undefined>({
    reducer: (x, y) => y,
    default: () => undefined,
  }),
  // 执行器返回的执行结果
  executionResult: Annotation<ExecutionResult | undefined>({
    reducer: (x, y) => y,
    default: () => undefined,
  }),
  // 最终回答文本（若产生则退出循环）
  finalAnswer: Annotation<string | undefined>({
    reducer: (x, y) => y,
    default: () => undefined,
  }),
  // 是否因超过迭代上限熔断
  isMaxIterationError: Annotation<boolean>({
    reducer: (x, y) => (y !== undefined ? y : x),
    default: () => false,
  }),
  // 步骤轨迹记录列表
  steps: Annotation<GraphStep[]>({
    reducer: (x, y) => (Array.isArray(y) ? x.concat(y) : x),
    default: () => [],
  }),
});

/** 图完整状态类型定义 */
export type AgentStateType = typeof AgentStateAnnotation.State;
/** 图状态局部更新类型定义 */
export type AgentStateUpdate = typeof AgentStateAnnotation.Update;
