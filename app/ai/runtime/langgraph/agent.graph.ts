import { isTokenUsage } from '../../trace/token-usage';
import { END, START, StateGraph } from '@langchain/langgraph';
import type { LlmToolMessage } from '../../contracts';
import { ExecutionResult } from '../../contracts';
import { ExecutorService } from '../../tool/executor.service';
import type {
  LangChainPlannerService,
  LangChainToolCall,
} from '../langchain/langchain-planner.service';
import {
  AgentStateAnnotation,
  type AgentStateType,
  type AgentStateUpdate,
  type GraphStep,
} from './agent.state';

/**
 * 运行图依赖上下文接口 (AgentGraphDeps)
 * 为图节点注入执行所需的规划器、执行器、会话标识与步骤记录钩子
 */
export interface AgentGraphDeps {
  /** LangChain 规划器服务实例 */
  planner: LangChainPlannerService;
  /** 能力执行器服务实例 */
  executor: ExecutorService;
  /** 运行追踪 ID */
  runId: string;
  /** 当前运行的 Agent 唯一名称 */
  agentName: string;
  /** 可选的模型名称覆盖 */
  agentModel?: string;
  /** 步骤产生时的持久化与实时推送回调钩子 */
  recordStep?: (step: GraphStep) => Promise<void> | void;
}

/**
 * 观察结果序列化辅助函数
 *
 * @param value 任意观察结果对象或字符串
 * @returns 字符串内容
 */
function serializeObservation(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

/**
 * 构造达到最大迭代轮次时的熔断步骤
 *
 * @param maxIterations 最大迭代上限
 * @param output 熔断说明文本
 * @returns GraphStep 步骤实体
 */
function buildMaxIterationStep(maxIterations: number, output: string): GraphStep {
  return {
    type: 'final',
    node: 'plan',
    iteration: maxIterations,
    output,
    error: { code: 'MAX_ITERATIONS', message: output },
    timestamp: new Date().toISOString(),
  };
}

/**
 * 构造规划器调用工具步骤
 *
 * @param iteration 当前迭代轮次
 * @param toolCall 解析出的工具调用项
 * @returns GraphStep 步骤实体（包含 node='plan', planner='langchain'）
 */
function buildPlanToolStep(iteration: number, toolCall: LangChainToolCall): GraphStep {
  return {
    type: 'plan',
    node: 'plan',
    planner: 'langchain',
    iteration,
    output: {
      type: 'invoke',
      name: toolCall.name,
      input: toolCall.args,
    },
    toolCallId: toolCall.id,
    timestamp: new Date().toISOString(),
  };
}

/**
 * 构造规划器最终产出结论步骤
 *
 * @param iteration 当前迭代轮次
 * @param finalOutput 最终回答文本
 * @returns GraphStep 步骤实体
 */
function buildPlanFinalStep(iteration: number, finalOutput: string): GraphStep {
  return {
    type: 'plan',
    node: 'plan',
    planner: 'langchain',
    iteration,
    output: {
      type: 'final',
      output: finalOutput,
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * 构造执行器调用具体能力后的执行步骤
 *
 * @param iteration 当前迭代轮次
 * @param toolCall 对应的工具调用指令
 * @param execution 执行器产出的 ExecutionResult
 * @returns GraphStep 步骤实体（标记 node='execute'）
 */
function buildExecutionStep(
  iteration: number,
  toolCall: LangChainToolCall,
  execution: ExecutionResult,
): GraphStep {
  return {
    type: execution.type,
    node: 'execute',
    iteration,
    name: execution.name,
    ...(execution.source ? { source: execution.source } : {}),
    input: toolCall.args,
    output: execution.output,
    error: execution.error,
    toolCallId: toolCall.id,
    timestamp: new Date().toISOString(),
  };
}

/**
 * 构造模型对执行事实的观察步骤 (observe)
 *
 * @param iteration 当前迭代轮次
 * @param name 能力名称
 * @param observation 序列化的观察事实对象
 * @param toolCallId 工具调用关联 ID
 * @returns GraphStep 步骤实体（标记 node='observe'）
 */
function buildObserveStep(
  iteration: number,
  name: string,
  observation: unknown,
  toolCallId: string,
): GraphStep {
  return {
    type: 'observe',
    node: 'observe',
    iteration,
    name,
    output: observation,
    toolCallId,
    timestamp: new Date().toISOString(),
  };
}

/**
 * 构造 plan 节点处理函数
 *
 * 【核心逻辑】
 * 1. 递增当前迭代轮次；
 * 2. 校验计数刹车：若超过 `maxIterations`，记录熔断步骤并返回结束；
 * 3. 调用 `planner.plan` 获取单轮决策；
 * 4. 若产生 `toolCalls`，记录 plan 步并回填 assistant 消息，等待流转至 execute；
 * 5. 若产出 `finalAnswer`，记录 final 步并设置 `finalAnswer`，等待条件边流转至 END。
 *
 * @param deps 外部注入的依赖服务与回调
 * @returns 节点处理异步函数
 */
export function createPlanNode(deps?: Partial<AgentGraphDeps>) {
  return async (state: AgentStateType): Promise<AgentStateUpdate> => {
    const currentIteration = state.iteration + 1;

    // 迭代轮次刹车：超过 maxIterations 立即熔断
    if (currentIteration > state.maxIterations) {
      const output = `Agent reached the maximum of ${state.maxIterations} iterations`;
      const finalStep = buildMaxIterationStep(state.maxIterations, output);
      if (deps?.recordStep) {
        await deps.recordStep(finalStep);
      }
      return {
        iteration: currentIteration,
        finalAnswer: output,
        isMaxIterationError: true,
        steps: [finalStep],
      };
    }

    if (!deps?.planner) {
      return {
        iteration: currentIteration,
        finalAnswer: '',
      };
    }

    // 执行 LangChain 规划
    const planResult = await deps.planner.plan(state.messages, state.tools, {
      model: deps.agentModel,
    });

    // 每轮模型调用只在规划步骤上记录一次，即使该轮请求多个工具。
    const usage = isTokenUsage(planResult.usage) ? planResult.usage : null;

    // 分支一：规划出调用工具
    if (planResult.toolCalls && planResult.toolCalls.length > 0) {
      const firstCall = planResult.toolCalls[0];
      const planStep = { ...buildPlanToolStep(currentIteration, firstCall), usage };

      if (deps.recordStep) {
        await deps.recordStep(planStep);
      }

      const nextMessages = [...state.messages];
      if (planResult.response) {
        nextMessages.push(planResult.response);
      }

      return {
        iteration: currentIteration,
        messages: nextMessages,
        toolCalls: planResult.toolCalls,
        finalAnswer: undefined,
        steps: [planStep],
      };
    }

    // 分支二：直接产出最终回答
    const finalOutput = planResult.finalAnswer ?? '';
    const planStep = { ...buildPlanFinalStep(currentIteration, finalOutput), usage };

    if (deps.recordStep) {
      await deps.recordStep(planStep);
    }

    const nextMessages = [...state.messages];
    if (planResult.response) {
      nextMessages.push(planResult.response);
    }

    return {
      iteration: currentIteration,
      messages: nextMessages,
      toolCalls: undefined,
      finalAnswer: finalOutput,
      steps: [planStep],
    };
  };
}

/**
 * 构造 execute 节点处理函数
 *
 * 【核心逻辑】
 * 1. 从当前状态提取首个待执行工具调用 `toolCalls[0]`；
 * 2. 调度 `ExecutorService.execute` 执行具体业务 Skill 或通用 Tool；
 * 3. 记录带有 `node: 'execute'` 观测标识的执行步骤；
 * 4. 保存 `executionResult` 供后续 observe 节点提取。
 *
 * @param deps 外部注入的依赖服务与回调
 * @returns 节点处理异步函数
 */
export function createExecuteNode(deps?: Partial<AgentGraphDeps>) {
  return async (state: AgentStateType): Promise<AgentStateUpdate> => {
    const toolCall = state.toolCalls?.[0];
    if (!toolCall || !deps?.executor) {
      return {};
    }

    const execution = await deps.executor.execute(
      toolCall.name,
      toolCall.args,
      { runId: deps.runId ?? '', agent: deps.agentName ?? '' },
    );

    const executionStep = buildExecutionStep(state.iteration, toolCall, execution);

    if (deps.recordStep) {
      await deps.recordStep(executionStep);
    }

    return {
      executionResult: execution,
      steps: [executionStep],
    };
  };
}

/**
 * 构造 observe 节点处理函数
 *
 * 【核心逻辑】
 * 1. 提取执行结果并安全构建 observation 事实数据；
 * 2. 构造规范的 `role: 'tool'` 消息回填至历史上下文；
 * 3. 记录带有 `node: 'observe'` 观测标识的观察步骤；
 * 4. 重置 `toolCalls` 与 `executionResult`，准备进入下一轮 plan。
 *
 * @param deps 外部注入的依赖服务与回调
 * @returns 节点处理异步函数
 */
export function createObserveNode(deps?: Partial<AgentGraphDeps>) {
  return async (state: AgentStateType): Promise<AgentStateUpdate> => {
    const toolCall = state.toolCalls?.[0];
    const execution = state.executionResult;
    if (!toolCall || !execution) {
      return {
        toolCalls: undefined,
        executionResult: undefined,
      };
    }

    const observation = execution.error
      ? { error: execution.error }
      : { output: execution.output };
    const toolCallId = toolCall.id ?? `call-${state.iteration}`;

    // OpenAI 规范回填 tool 消息
    const toolMessage: LlmToolMessage = {
      role: 'tool',
      tool_call_id: toolCallId,
      content: serializeObservation(observation),
    };

    const nextMessages = [...state.messages, toolMessage];
    const newSteps: GraphStep[] = [];

    if (execution.type !== 'observe') {
      const observeStep = buildObserveStep(state.iteration, execution.name, observation, toolCallId);
      if (deps?.recordStep) {
        await deps.recordStep(observeStep);
      }
      newSteps.push(observeStep);
    }

    return {
      messages: nextMessages,
      toolCalls: undefined,
      executionResult: undefined,
      steps: newSteps,
    };
  };
}

/**
 * plan 节点后的条件路由判断
 *
 * @param state 当前图状态
 * @returns 若已有 finalAnswer 则返回 END，否则返回 'execute'
 */
export function routeAfterPlan(state: AgentStateType): string {
  if (state.finalAnswer !== undefined) {
    return END;
  }
  return 'execute';
}

/**
 * 构建并编译 LangGraph Agent 循环图
 *
 * 【图拓扑结构】
 * 1. 节点：plan、execute、observe
 * 2. 边：
 *    - START -> plan
 *    - plan -> execute（当有 toolCalls 时）
 *    - plan -> END（当产出 finalAnswer 或达到迭代轮次刹车时）
 *    - execute -> observe
 *    - observe -> plan
 * 3. 计数刹车：
 *    采用 state.iteration 对比 state.maxIterations 计数刹车，不依赖底层 node-visit recursionLimit。
 *
 * @param deps 依赖的服务与回调
 * @returns 编译好的 CompiledStateGraph
 */
export function createAgentGraph(deps?: Partial<AgentGraphDeps>) {
  return new StateGraph(AgentStateAnnotation)
    .addNode('plan', createPlanNode(deps))
    .addNode('execute', createExecuteNode(deps))
    .addNode('observe', createObserveNode(deps))
    .addEdge(START, 'plan')
    .addConditionalEdges('plan', routeAfterPlan, {
      execute: 'execute',
      [END]: END,
    })
    .addEdge('execute', 'observe')
    .addEdge('observe', 'plan')
    .compile();
}

/**
 * 默认空依赖编译图实例（用于拓扑反射 GET agent/graph）
 */
export const defaultAgentGraph = createAgentGraph();
