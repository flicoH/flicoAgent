import { randomUUID } from 'node:crypto';
import { END, START, StateGraph } from '@langchain/langgraph';
import type { AgentLoopMode } from '../../agent/agent.interface';
import type { ExecutionResult, LlmToolMessage } from '../../contracts';
import { CapabilityApprovalRequired, ExecutorService } from '../../tool/executor.service';
import { isTokenUsage } from '../../trace/token-usage';
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

export interface AgentGraphDeps {
  planner: LangChainPlannerService;
  executor: ExecutorService;
  allowed?: { skills: string[]; tools: string[] };
  executeCall?: (call: LangChainToolCall, options?: { approved?: boolean }) => Promise<ExecutionResult>;
  takeModelCall?: () => boolean;
  runId: string;
  agentName: string;
  agentModel?: string;
  mode?: AgentLoopMode;
  maxReflectionRevisions?: number;
  signal?: AbortSignal;
  startFromExecute?: boolean;
  onDelta?: (content: string) => void | Promise<void>;
  resetDelta?: () => void | Promise<void>;
  recordStep?: (step: GraphStep) => Promise<void> | void;
}

function serializeObservation(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('Agent execution aborted');
    err.name = 'AbortError';
    throw err;
  }
}

async function startModelCall(
  state: AgentStateType,
  deps: Partial<AgentGraphDeps>,
  node: GraphStep['node'],
): Promise<AgentStateUpdate | undefined> {
  throwIfAborted(deps.signal);
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
    const startedAt = Date.now();
    const result = await deps.planner.plan(
      [...state.messages, { role: 'user', content: instruction(state) }],
      [],
      {
        model: deps.agentModel,
        signal: deps.signal,
        ...(node === 'synthesize' ? { onDelta: deps.onDelta, resetDelta: deps.resetDelta } : {}),
      },
    );
    const modelDurationMs = Math.max(0, Date.now() - startedAt);
    throwIfAborted(deps.signal);

    const text = result.toolCalls?.length ? '' : (result.finalAnswer ?? '');
    const stage = interpret(text, state);
    const terminalError = stage.error && node !== 'review';
    const step: GraphStep = {
      type: terminalError ? 'final' : 'plan',
      node,
      planner: 'langchain',
      iteration,
      output: terminalError ? stage.update.finalAnswer : stage.output,
      error: stage.error,
      usage: isTokenUsage(result.usage) ? result.usage : null,
      modelDurationMs,
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

    const streamDeltas = !deps.mode || deps.mode === 'react';
    const startedAt = Date.now();
    const planResult = await deps.planner.plan(state.messages, state.tools, {
      model: deps.agentModel,
      signal: deps.signal,
      ...(streamDeltas ? { onDelta: deps.onDelta, resetDelta: deps.resetDelta } : {}),
    });
    const modelDurationMs = Math.max(0, Date.now() - startedAt);
    throwIfAborted(deps.signal);

    const usage = isTokenUsage(planResult.usage) ? planResult.usage : null;

    if (planResult.toolCalls && planResult.toolCalls.length > 0) {
      const firstCall = planResult.toolCalls[0];
      const planStep: GraphStep = { ...buildPlanToolStep(currentIteration, firstCall), usage, modelDurationMs };

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
        executionResults: [],
        resumeIndex: 0,
        pendingApproval: undefined,
        approvedCallId: undefined,
        rejectedCallId: undefined,
        finalAnswer: undefined,
        steps: [planStep],
      };
    }

    const finalOutput = planResult.finalAnswer ?? '';
    const planStep: GraphStep = { ...buildPlanFinalStep(currentIteration, finalOutput), usage, modelDurationMs };

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
      executionResults: [],
      resumeIndex: 0,
      pendingApproval: undefined,
      approvedCallId: undefined,
      rejectedCallId: undefined,
      finalAnswer: executingTask ? undefined : finalOutput,
      ...(executingTask ? { taskIndex: state.taskIndex + 1 } : {}),
      steps: [planStep],
    };
  };
}

export function createExecuteNode(deps?: Partial<AgentGraphDeps>) {
  return async (state: AgentStateType): Promise<AgentStateUpdate> => {
    const calls = state.toolCalls ?? [];
    const results: ExecutionResult[] = [...(state.executionResults ?? [])];
    const steps: GraphStep[] = [];
    const startIndex = Math.max(0, state.resumeIndex ?? results.length);

    for (let index = startIndex; index < calls.length; index++) {
      throwIfAborted(deps?.signal);
      const call = calls[index];
      const approved = Boolean(state.approvedCallId && state.approvedCallId === call.id);
      const rejected = Boolean(state.rejectedCallId && state.rejectedCallId === call.id);

      let execution: ExecutionResult;
      if (rejected) {
        execution = {
          type: 'observe',
          name: call.name,
          error: {
            code: 'APPROVAL_REJECTED',
            message: `Approval for "${call.name}" was rejected`,
          },
        };
      } else {
        if (!deps?.executeCall && !deps?.executor) {
          break;
        }
        try {
          execution = deps.executeCall
            ? await deps.executeCall(call, { approved })
            : await deps.executor!.execute(
              call.name,
              call.args,
              { runId: deps.runId ?? '', agent: deps.agentName ?? '', signal: deps.signal },
              deps.allowed,
              false,
              { approved, checkApproval: false },
            );
        } catch (error) {
          if (error instanceof CapabilityApprovalRequired) {
            return {
              executionResults: results,
              steps,
              resumeIndex: index,
              approvedCallId: undefined,
              rejectedCallId: undefined,
              pendingApproval: {
                id: randomUUID(),
                kind: error.kind,
                name: error.capabilityName,
                input: error.input,
                index,
                callId: call.id,
              },
            };
          }
          throw error;
        }
      }

      const step = buildExecutionStep(state.iteration, call, execution);
      await deps?.recordStep?.(step);
      results.push(execution);
      steps.push(step);
    }

    return {
      executionResults: results,
      steps,
      resumeIndex: 0,
      approvedCallId: undefined,
      rejectedCallId: undefined,
      pendingApproval: undefined,
    };
  };
}

export function createObserveNode(deps?: Partial<AgentGraphDeps>) {
  return async (state: AgentStateType): Promise<AgentStateUpdate> => {
    const messages = [...state.messages];
    const steps: GraphStep[] = [];
    for (const [index, execution] of state.executionResults.entries()) {
      const call = state.toolCalls![index];
      const observation = execution.error
        ? { error: execution.error, ...(execution.childRunId ? { childRunId: execution.childRunId } : {}) }
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
    return { messages, toolCalls: undefined, executionResults: [], resumeIndex: 0, steps };
  };
}

export function routeAfterPlan(state: AgentStateType): string {
  if (state.finalAnswer !== undefined) {
    return END;
  }
  return 'execute';
}

function routeAfterExecute(state: AgentStateType): string {
  return state.pendingApproval ? END : 'observe';
}

export function createAgentGraph(deps?: Partial<AgentGraphDeps>) {
  const graph = new StateGraph(AgentStateAnnotation)
    .addNode('plan', createPlanNode(deps))
    .addNode('execute', createExecuteNode(deps))
    .addNode('observe', createObserveNode(deps))
    .addConditionalEdges('execute', routeAfterExecute, { observe: 'observe', [END]: END })
    .addEdge('observe', 'plan');

  if (deps?.mode === 'plan-and-execute') {
    return graph
      .addNode('make-plan', createTaskPlanningNode(deps))
      .addNode('synthesize', createSynthesisNode(deps))
      .addEdge(START, deps.startFromExecute ? 'execute' : 'make-plan')
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
      .addEdge(START, deps.startFromExecute ? 'execute' : 'plan')
      .addConditionalEdges('plan', state => {
        if (state.isMaxIterationError) return END;
        return state.finalAnswer !== undefined ? 'review' : 'execute';
      }, [END, 'review', 'execute'])
      .addConditionalEdges('review', state => state.finalAnswer !== undefined ? END : 'plan', [END, 'plan'])
      .compile();
  }

  return graph
    .addEdge(START, deps?.startFromExecute ? 'execute' : 'plan')
    .addConditionalEdges('plan', routeAfterPlan, { execute: 'execute', [END]: END })
    .compile();
}

export const defaultAgentGraph = createAgentGraph();
