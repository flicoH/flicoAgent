import { isTokenUsage } from '../../trace/token-usage';
import { END, START, StateGraph } from '@langchain/langgraph';
import type { AgentLoopMode } from '../../agent/agent.interface';
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
  executeCall?: (call: LangChainToolCall) => Promise<ExecutionResult>;
  takeModelCall?: () => boolean;
  /** 运行追踪 ID */
  runId: string;
  /** 当前运行的 Agent 唯一名称 */
  agentName: string;
  /** 可选的模型名称覆盖 */
  agentModel?: string;
  mode?: AgentLoopMode;
  maxReflectionRevisions?: number;
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

async function startModelCall(
  state: AgentStateType,
  deps: Partial<AgentGraphDeps>,
  node: GraphStep['node'],
): Promise<AgentStateUpdate | undefined> {
  const iteration = state.iteration + 1;
  const exceededIterations = iteration > state.maxIterations;
  if (!exceededIterations && (!deps.takeModelCall || deps.takeModelCall())) {
    return undefined;
  }

  const error = exceededIterations
    ? { code: 'MAX_ITERATIONS', message: `Agent reached the maximum of ${state.maxIterations} iterations` }
    : { code: 'DELEGATE_BUDGET_EXCEEDED', message: 'Agent tree reached its model call budget' };
  const output = state.finalAnswer ?? state.previousDraft ?? error.message;
  const step: GraphStep = {
    type: 'final', node, iteration: Math.min(iteration, state.maxIterations),
    output, error, timestamp: new Date().toISOString(),
  };
  await deps.recordStep?.(step);
  return { iteration, finalAnswer: output, isMaxIterationError: true, steps: [step] };
}

function parseJson(text: string): unknown {
  const fenced = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  try {
    return JSON.parse(fenced?.[1] ?? text);
  } catch {
    return undefined;
  }
}

/** 规划、审阅和汇总是独立的纯模型阶段，没有工具执行权限。 */
function createTextStage(
  node: 'make-plan' | 'review' | 'synthesize',
  deps: Partial<AgentGraphDeps>,
  instruction: (state: AgentStateType) => string,
  interpret: (text: string, state: AgentStateType) => {
    update: AgentStateUpdate;
    output?: unknown;
    error?: GraphStep['error'];
  },
) {
  return async (state: AgentStateType): Promise<AgentStateUpdate> => {
    if (!deps.planner) {
      return { finalAnswer: '' };
    }
    const halted = await startModelCall(state, deps, node);
    if (halted) {
      return halted;
    }

    const iteration = state.iteration + 1;
    const result = await deps.planner.plan(
      [...state.messages, { role: 'user', content: instruction(state) }],
      [],
      { model: deps.agentModel },
    );
    const text = result.toolCalls?.length ? '' : (result.finalAnswer ?? '');
    const stage = interpret(text, state);
    const terminalError = stage.error && node !== 'review';
    const step: GraphStep = {
      type: terminalError ? 'final' : 'plan', node, planner: 'langchain', iteration,
      output: terminalError ? stage.update.finalAnswer : stage.output,
      error: stage.error,
      usage: isTokenUsage(result.usage) ? result.usage : null,
      timestamp: new Date().toISOString(),
    };
    await deps.recordStep?.(step);
    return { ...stage.update, iteration, steps: [step] };
  };
}

function taskInstruction(plan: string[], index: number) {
  return {
    role: 'user' as const,
    content: `Work only on step ${index + 1} of ${plan.length}: ${plan[index]}. ` +
      'Use available tools if necessary, then give the result of this step.',
  };
}

function createTaskPlanningNode(deps: Partial<AgentGraphDeps>) {
  return createTextStage('make-plan', deps, state =>
    'Create an ordered execution plan for the user request. Return only a JSON array of non-empty step strings. ' +
    `Use between 1 and ${Math.max(1, state.maxIterations - 2)} steps, fewer if tools may require multiple calls. ` +
    'Use only these tools if needed during execution: ' + (state.tools.map(tool => tool.name).join(', ') || 'none'),
  (text, state) => {
    const plan = parseJson(text);
    const maxSteps = Math.max(1, state.maxIterations - 2);
    if (Array.isArray(plan) && plan.length > 0 && plan.length <= maxSteps
      && plan.every(step => typeof step === 'string' && step.trim())) {
      return {
        update: { taskPlan: plan, messages: [...state.messages, taskInstruction(plan, 0)] },
        output: plan,
      };
    }
    const error = { code: 'INVALID_TASK_PLAN', message: 'Model did not produce a valid execution plan' };
    return { update: { finalAnswer: error.message }, error };
  });
}

function createSynthesisNode(deps: Partial<AgentGraphDeps>) {
  return createTextStage('synthesize', deps, state =>
    'Answer the original user request by synthesizing the completed steps and observations. ' +
    'Report any unresolved issues. Plan: ' + JSON.stringify(state.taskPlan),
  text => {
    if (text.trim()) {
      return { update: { finalAnswer: text }, output: text };
    }
    const error = { code: 'INVALID_SYNTHESIS', message: 'Model did not produce a final synthesis' };
    return { update: { finalAnswer: error.message }, error };
  });
}

function createReviewNode(deps: Partial<AgentGraphDeps>) {
  const maxRevisions = deps.maxReflectionRevisions ?? 1;
  return createTextStage('review', deps, () =>
    'Review the latest draft against the original user request and any tool evidence. ' +
    'Return only JSON with a boolean approved and a string feedback. Explain what to fix if not approved.',
  (text, state) => {
    const draft = state.finalAnswer;
    const verdict = parseJson(text) as { approved?: unknown; feedback?: unknown } | null;
    if (typeof verdict?.approved !== 'boolean' || typeof verdict.feedback !== 'string'
      || (!verdict.approved && !verdict.feedback.trim())) {
      return {
        update: { finalAnswer: draft },
        error: { code: 'INVALID_REFLECTION_REVIEW', message: 'Model did not produce a valid review' },
      };
    }
    if (verdict.approved) {
      return { update: { finalAnswer: draft }, output: verdict };
    }
    if (state.reflectionRevisions >= maxRevisions) {
      return {
        update: { finalAnswer: draft },
        output: verdict,
        error: { code: 'REFLECTION_LIMIT', message: 'Draft still needs revision after reaching the revision limit' },
      };
    }
    return {
      update: {
        finalAnswer: undefined,
        previousDraft: draft,
        reflectionRevisions: state.reflectionRevisions + 1,
        messages: [...state.messages, {
          role: 'user',
          content: 'Revise the previous draft for the original request using this review feedback: ' + verdict.feedback,
        }],
      },
      output: verdict,
    };
  });
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
    ...(execution.childRunId ? { childRunId: execution.childRunId } : {}),
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

    if (!deps?.planner) {
      return { iteration: currentIteration, finalAnswer: '' };
    }
    const halted = await startModelCall(state, deps, 'plan');
    if (halted) {
      return halted;
    }

    const planResult = await deps.planner.plan(state.messages, state.tools, { model: deps.agentModel });

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

    const executingTask = deps.mode === 'plan-and-execute';
    const nextMessages = [...state.messages];
    if (planResult.response || executingTask || deps.mode === 'reflection') {
      nextMessages.push(planResult.response ?? { role: 'assistant', content: finalOutput });
    }

    if (executingTask && state.taskIndex + 1 < state.taskPlan.length) {
      nextMessages.push(taskInstruction(state.taskPlan, state.taskIndex + 1));
    }

    return {
      iteration: currentIteration,
      messages: nextMessages,
      toolCalls: undefined,
      finalAnswer: executingTask ? undefined : finalOutput,
      ...(executingTask ? { taskIndex: state.taskIndex + 1 } : {}),
      steps: [planStep],
    };
  };
}

/**
 * 构造 execute 节点处理函数
 *
 * 【核心逻辑】
 * 1. 按模型返回的顺序串行执行待处理工具调用；
 * 2. 调度 `ExecutorService.execute` 执行具体业务 Skill 或通用 Tool；
 * 3. 记录带有 `node: 'execute'` 观测标识的执行步骤；
 * 4. 保存 `executionResults` 供后续 observe 节点提取。
 *
 * @param deps 外部注入的依赖服务与回调
 * @returns 节点处理异步函数
 */
export function createExecuteNode(deps?: Partial<AgentGraphDeps>) {
  return async (state: AgentStateType): Promise<AgentStateUpdate> => {
    const results: ExecutionResult[] = [];
    const steps: GraphStep[] = [];
    for (const call of state.toolCalls ?? []) {
      if (!deps?.executor) {
        break;
      }
      const execution = deps.executeCall ? await deps.executeCall(call) : await deps.executor.execute(
        call.name,
        call.args,
        { runId: deps.runId ?? '', agent: deps.agentName ?? '' },
      );
      const step = buildExecutionStep(state.iteration, call, execution);
      await deps.recordStep?.(step);
      results.push(execution);
      steps.push(step);
    }
    return { executionResults: results, steps };
  };
}

/**
 * 构造 observe 节点处理函数
 *
 * 【核心逻辑】
 * 1. 提取执行结果并安全构建 observation 事实数据；
 * 2. 构造规范的 `role: 'tool'` 消息回填至历史上下文；
 * 3. 记录带有 `node: 'observe'` 观测标识的观察步骤；
 * 4. 重置 `toolCalls` 与 `executionResults`，准备进入下一轮 plan。
 *
 * @param deps 外部注入的依赖服务与回调
 * @returns 节点处理异步函数
 */
export function createObserveNode(deps?: Partial<AgentGraphDeps>) {
  return async (state: AgentStateType): Promise<AgentStateUpdate> => {
    const messages = [...state.messages];
    const steps: GraphStep[] = [];
    for (const [index, execution] of state.executionResults.entries()) {
      const call = state.toolCalls![index];
      const observation = execution.error
        ? { error: execution.error, childRunId: execution.childRunId }
        : { output: execution.output };
      const toolCallId = call.id ?? `call-${state.iteration}-${index}`;
      const message: LlmToolMessage = {
        role: 'tool',
        tool_call_id: toolCallId,
        content: serializeObservation(observation),
      };
      messages.push(message);

      if (execution.type !== 'observe') {
        const step = buildObserveStep(state.iteration, execution.name, observation, toolCallId);
        await deps?.recordStep?.(step);
        steps.push(step);
      }
    }
    return { messages, toolCalls: undefined, executionResults: [], steps };
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
  const graph = new StateGraph(AgentStateAnnotation)
    .addNode('plan', createPlanNode(deps))
    .addNode('execute', createExecuteNode(deps))
    .addNode('observe', createObserveNode(deps))
    .addEdge('execute', 'observe')
    .addEdge('observe', 'plan');

  if (deps?.mode === 'plan-and-execute') {
    return graph
      .addNode('make-plan', createTaskPlanningNode(deps))
      .addNode('synthesize', createSynthesisNode(deps))
      .addEdge(START, 'make-plan')
      .addConditionalEdges('make-plan', state => state.finalAnswer !== undefined ? END : 'plan', [END, 'plan'])
      .addConditionalEdges('plan', state => {
        if (state.finalAnswer !== undefined) return END;
        if (state.toolCalls?.length) return 'execute';
        return state.taskIndex < state.taskPlan.length ? 'plan' : 'synthesize';
      }, [END, 'execute', 'plan', 'synthesize'])
      .addEdge('synthesize', END)
      .compile();
  }

  if (deps?.mode === 'reflection') {
    return graph
      .addNode('review', createReviewNode(deps))
      .addEdge(START, 'plan')
      .addConditionalEdges('plan', state => {
        if (state.isMaxIterationError) return END;
        return state.finalAnswer !== undefined ? 'review' : 'execute';
      }, [END, 'review', 'execute'])
      .addConditionalEdges('review', state => state.finalAnswer !== undefined ? END : 'plan', [END, 'plan'])
      .compile();
  }

  return graph
    .addEdge(START, 'plan')
    .addConditionalEdges('plan', routeAfterPlan, { execute: 'execute', [END]: END })
    .compile();
}

/**
 * 默认空依赖编译图实例（用于拓扑反射 GET agent/graph）
 */
export const defaultAgentGraph = createAgentGraph();
