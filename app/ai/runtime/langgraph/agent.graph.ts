import { performance } from 'node:perf_hooks';
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
  allowed?: { skills: readonly string[]; tools: readonly string[] };
  context?: Record<string, unknown>;
  signal?: AbortSignal;
  /** 规划前扣减根运行及所有子运行共享的模型调用预算。返回 false 时记录熔断步骤。 */
  consumeModel?: () => boolean;
  /** 编排器在此处理审批和委派。返回 null 表示当前调用尚未执行，图应先退出。 */
  executeCall?: (state: AgentStateType, call: LangChainToolCall,
    completed: AgentStateType['executionResults']) => Promise<ExecutionResult | null>;
  onDelta?: (content: string) => Promise<void> | void;
  resetDelta?: () => Promise<void> | void;
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
function buildMaxIterationStep(maxIterations: number, output: string, code: string): GraphStep {
  return {
    type: 'final',
    node: 'plan',
    iteration: maxIterations,
    output,
    error: { code, message: output },
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
    ...(execution.citations ? { citations: execution.citations } : {}),
    ...(execution.childRunId ? { childRunId: execution.childRunId } : {}),
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
    deps?.signal?.throwIfAborted();
    const currentIteration = state.iteration + 1;

    // 迭代轮次刹车：超过 maxIterations 立即熔断
    const iterationLimit = currentIteration > state.maxIterations;
    if (iterationLimit || deps?.consumeModel?.() === false) {
      const output = iterationLimit
        ? `Agent reached the maximum of ${state.maxIterations} iterations`
        : 'Agent reached the shared model call budget';
      const finalStep = buildMaxIterationStep(state.iteration, output, iterationLimit ? 'MAX_ITERATIONS' : 'MODEL_BUDGET_EXCEEDED');
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
    const startedAt = performance.now();
    const planResult = await deps.planner.plan(state.messages, state.tools, {
      model: deps.agentModel,
      signal: deps.signal,
      onDelta: deps.onDelta,
      resetDelta: deps.resetDelta,
    }).catch(async error => {
      // 失败轮次也要可观测，且不把供应商异常原文或凭据写入 Trace。
      if (!deps.signal?.aborted) await deps.recordStep?.({
        type: 'plan', node: 'plan', planner: 'langchain', iteration: currentIteration,
        modelDurationMs: Math.round(performance.now() - startedAt),
        error: { code: 'MODEL_FAILED', message: 'Agent model call failed' }, timestamp: new Date().toISOString(),
      });
      throw error;
    });
    deps.signal?.throwIfAborted();

    const duration = Math.round(performance.now() - startedAt);
    // 两条分支都回填模型原始消息，以保留下一轮工具应答关联。
    const nextMessages = [...state.messages];
    if (planResult.response) nextMessages.push(planResult.response);

    if (planResult.toolCalls && planResult.toolCalls.length > 0) {
      const planSteps = planResult.toolCalls.map(call => buildPlanToolStep(currentIteration, call));
      // 同一模型响应可能声明多个工具，只记一次该轮用量。
      planSteps[0].modelDurationMs = duration;
      if (planResult.usage) planSteps[0].usage = planResult.usage;
      for (const step of planSteps) {
        await deps.recordStep?.(step);
      }

      return {
        iteration: currentIteration,
        messages: nextMessages,
        toolCalls: planResult.toolCalls,
        finalAnswer: undefined,
        steps: planSteps,
      };
    }

    const finalOutput = planResult.finalAnswer ?? '';
    const planStep = buildPlanFinalStep(currentIteration, finalOutput);
    planStep.modelDurationMs = duration;
    if (planResult.usage) planStep.usage = planResult.usage;
    await deps.recordStep?.(planStep);

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
 * 顺序执行当前轮的工具调用，让有副作用的工具保持模型给出的调用顺序。
 *
 * @param deps 外部注入的依赖服务与回调
 * @returns 节点处理异步函数
 */
export function createExecuteNode(deps?: Partial<AgentGraphDeps>) {
  return async (state: AgentStateType): Promise<AgentStateUpdate> => {
    if (!deps?.executor) {
      return {};
    }

    // 只有从审批快照进入 execute 时才带已完成的本轮结果。
    const executionResults = [...(state.executionResults ?? [])];
    const steps: GraphStep[] = [];
    for (const call of (state.toolCalls ?? []).slice(executionResults.length)) {
      deps.signal?.throwIfAborted();
      const result = deps.executeCall ? await deps.executeCall(state, call, executionResults) : await deps.executor.execute(
        call.name,
        call.args,
        { ...deps.context, runId: deps.runId, agent: deps.agentName, signal: deps.signal },
        deps.allowed,
      );
      // 暂停时保留已完成的调用结果。等到本批工具全部有应答之后，observe 才统一续写消息。
      if (!result) return { waiting: true, executionResults, steps };
      deps.signal?.throwIfAborted();
      executionResults.push({ call, result });
      const step = buildExecutionStep(state.iteration, call, result);
      steps.push(step);
      await deps.recordStep?.(step);
    }

    return {
      executionResults,
      steps,
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
 * 4. 清空当轮调用与结果，准备进入下一轮 plan。
 *
 * @param deps 外部注入的依赖服务与回调
 * @returns 节点处理异步函数
 */
export function createObserveNode(deps?: Partial<AgentGraphDeps>) {
  return async (state: AgentStateType): Promise<AgentStateUpdate> => {
    deps?.signal?.throwIfAborted();
    const toolMessages: LlmToolMessage[] = [];
    const newSteps: GraphStep[] = [];
    for (const { call, result } of state.executionResults ?? []) {
      // 上游要求每个 tool_call 都有同 ID 的应答，包括被拒绝和执行失败的调用。
      const observation = result.error ? { error: result.error } : { output: result.output };
      toolMessages.push({ role: 'tool', tool_call_id: call.id, content: serializeObservation(observation) });
      if (result.type !== 'observe') {
        const step = buildObserveStep(state.iteration, result.name, observation, call.id);
        newSteps.push(step);
        await deps?.recordStep?.(step);
      }
    }

    return {
      messages: [...state.messages, ...toolMessages],
      toolCalls: undefined,
      executionResults: [],
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
 *    - START -> plan（新运行）或 execute（审批恢复）
 *    - plan -> execute（当有 toolCalls 时）
 *    - plan -> END（当产出 finalAnswer 或达到执行上限时）
 *    - execute -> observe（本轮每个工具均已有执行或拒绝结果）
 *    - execute -> END（等待审批，由编排器在图退出后持久化快照）
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
    .addConditionalEdges(START, state => state.resume ? 'execute' : 'plan', { plan: 'plan', execute: 'execute' })
    .addConditionalEdges('plan', routeAfterPlan, {
      execute: 'execute',
      [END]: END,
    })
    .addConditionalEdges('execute', state => state.waiting ? END : 'observe', { observe: 'observe', [END]: END })
    .addEdge('observe', 'plan')
    .compile();
}

/**
 * 默认空依赖编译图实例（用于拓扑反射 GET agent/graph）
 */
export const defaultAgentGraph = createAgentGraph();
