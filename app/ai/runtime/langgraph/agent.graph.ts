import { randomUUID } from 'node:crypto';
import { END, START, StateGraph } from '@langchain/langgraph';
import type { LlmGenerationOptions } from '../../../config/bootstrap-options';
import type { AgentLoopMode } from '../../agent/agent.interface';
import type { ExecutionResult, LlmFallbackEvent, LlmMessage, LlmToolMessage } from '../../contracts';
import { CapabilityApprovalRequired, ExecutorService } from '../../tool/executor.service';
import { isTokenUsage } from '../../trace/token-usage';
import { sanitizeLlmFallbackMessage } from '../internal/llm-circuit-breaker';
import { DEFAULT_TOOL_CONCURRENCY } from '../internal/load-runtime-config';
import {
  buildStructuredOutputRepairPrompt,
  DEFAULT_MAX_OUTPUT_RETRIES,
  validateStructuredOutput,
} from '../internal/structured-output';
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
  requiresApproval?: (call: LangChainToolCall) => boolean;
  toolConcurrency?: number;
  takeModelCall?: () => boolean;
  runId: string;
  agentName: string;
  agentModel?: string;
  agentFallbacks?: string[];
  agentLlmOptions?: LlmGenerationOptions;
  outputSchema?: Record<string, unknown>;
  maxOutputRetries?: number;
  mode?: AgentLoopMode;
  maxReflectionRevisions?: number;
  signal?: AbortSignal;
  startFromExecute?: boolean;
  onDelta?: (content: string) => void | Promise<void>;
  resetDelta?: () => void | Promise<void>;
  recordStep?: (step: GraphStep) => Promise<void> | void;
}

function buildFallbackStep(
  node: NonNullable<GraphStep['node']>,
  iteration: number,
  event: LlmFallbackEvent,
): GraphStep {
  return {
    type: 'fallback',
    node,
    planner: 'langchain',
    iteration,
    name: `${event.fromModel}->${event.toModel}`,
    model: event.toModel,
    output: {
      fromModel: event.fromModel,
      toModel: event.toModel,
      reason: event.reason,
      ...(event.statusCode !== undefined ? { statusCode: event.statusCode } : {}),
      ...(event.circuitState ? { circuitState: event.circuitState } : {}),
      attempt: event.attempt,
    },
    error: {
      code: event.code,
      message: sanitizeLlmFallbackMessage(event),
    },
    timestamp: new Date().toISOString(),
  };
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
    const fallbackSteps: GraphStep[] = [];
    const startedAt = Date.now();
    const result = await deps.planner.plan(
      [...state.messages, { role: 'user', content: instruction(state) }],
      [],
      {
        model: deps.agentModel,
        ...(deps.agentFallbacks ? { fallbacks: deps.agentFallbacks } : {}),
        ...(deps.agentLlmOptions ?? {}),
        signal: deps.signal,
        ...(node === 'synthesize' && !deps.outputSchema ? { onDelta: deps.onDelta, resetDelta: deps.resetDelta } : {}),
        onFallback: async (event) => {
          const fallbackStep = buildFallbackStep(node, iteration, event);
          fallbackSteps.push(fallbackStep);
          await deps.recordStep?.(fallbackStep);
        },
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
      ...(result.model ? { model: result.model } : {}),
      output: terminalError ? stage.update.finalAnswer : stage.output,
      error: stage.error,
      usage: isTokenUsage(result.usage) ? result.usage : null,
      modelDurationMs,
      timestamp: new Date().toISOString(),
    };
    await deps.recordStep?.(step);
    return {
      ...stage.update,
      ...(terminalError ? { outputValidationDone: true } : {}),
      ...(node === 'synthesize' && deps.outputSchema && !terminalError
        ? { messages: [...state.messages, result.response ?? { role: 'assistant', content: text }] }
        : {}),
      iteration,
      steps: [...fallbackSteps, step],
    };
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

function buildPlanToolStep(iteration: number, toolCalls: LangChainToolCall[]): GraphStep {
  const firstCall = toolCalls[0];
  return {
    type: 'plan',
    node: 'plan',
    planner: 'langchain',
    iteration,
    output: {
      type: 'invoke',
      name: firstCall.name,
      input: firstCall.args,
      ...(toolCalls.length > 1
        ? {
          calls: toolCalls.map(call => ({
            id: call.id,
            name: call.name,
            input: call.args,
          })),
        }
        : {}),
    },
    toolCallId: firstCall.id,
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
    ...(execution.truncated ? { truncated: true } : {}),
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

    const streamDeltas = !deps.outputSchema && (!deps.mode || deps.mode === 'react');
    const fallbackSteps: GraphStep[] = [];
    const startedAt = Date.now();
    const planResult = await deps.planner.plan(state.messages, state.tools, {
      model: deps.agentModel,
      ...(deps.agentFallbacks ? { fallbacks: deps.agentFallbacks } : {}),
      ...(deps.agentLlmOptions ?? {}),
      signal: deps.signal,
      ...(streamDeltas ? { onDelta: deps.onDelta, resetDelta: deps.resetDelta } : {}),
      onFallback: async (event) => {
        const fallbackStep = buildFallbackStep('plan', currentIteration, event);
        fallbackSteps.push(fallbackStep);
        await deps.recordStep?.(fallbackStep);
      },
    });
    const modelDurationMs = Math.max(0, Date.now() - startedAt);
    throwIfAborted(deps.signal);

    const usage = isTokenUsage(planResult.usage) ? planResult.usage : null;

    if (planResult.toolCalls && planResult.toolCalls.length > 0) {
      const planStep: GraphStep = {
        ...buildPlanToolStep(currentIteration, planResult.toolCalls),
        ...(planResult.model ? { model: planResult.model } : {}),
        usage,
        modelDurationMs,
      };

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
        steps: [...fallbackSteps, planStep],
      };
    }

    const finalOutput = planResult.finalAnswer ?? '';
    const planStep: GraphStep = {
      ...buildPlanFinalStep(currentIteration, finalOutput),
      ...(planResult.model ? { model: planResult.model } : {}),
      usage,
      modelDurationMs,
    };

    if (deps.recordStep) {
      await deps.recordStep(planStep);
    }

    const executingTask = deps.mode === 'plan-and-execute';
    const nextMessages = [...state.messages];
    if (planResult.response || executingTask || deps.mode === 'reflection' || Boolean(deps.outputSchema)) {
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
      steps: [...fallbackSteps, planStep],
    };
  };
}

export function createExecuteNode(deps?: Partial<AgentGraphDeps>) {
  const executeSingleCall = async (
    call: LangChainToolCall,
    approved: boolean,
  ): Promise<ExecutionResult> => {
    if (deps?.executeCall) {
      return deps.executeCall(call, { approved });
    }
    return deps!.executor!.execute(
      call.name,
      call.args,
      { runId: deps?.runId ?? '', agent: deps?.agentName ?? '', signal: deps?.signal },
      deps?.allowed,
      false,
      { approved, checkApproval: false },
    );
  };

  const toPendingApprovalUpdate = (
    results: ExecutionResult[],
    steps: GraphStep[],
    index: number,
    call: LangChainToolCall,
    error: CapabilityApprovalRequired,
  ): AgentStateUpdate => ({
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
  });

  return async (state: AgentStateType): Promise<AgentStateUpdate> => {
    const calls = state.toolCalls ?? [];
    const results: ExecutionResult[] = [...(state.executionResults ?? [])];
    const steps: GraphStep[] = [];
    const startIndex = Math.max(0, state.resumeIndex ?? results.length);
    const concurrency = typeof deps?.toolConcurrency === 'number'
      && Number.isFinite(deps.toolConcurrency)
      && deps.toolConcurrency >= 1
      ? Math.floor(deps.toolConcurrency)
      : DEFAULT_TOOL_CONCURRENCY;

    let index = startIndex;
    while (index < calls.length) {
      throwIfAborted(deps?.signal);
      const call = calls[index];
      const approved = Boolean(state.approvedCallId && state.approvedCallId === call.id);
      const rejected = Boolean(state.rejectedCallId && state.rejectedCallId === call.id);

      if (rejected) {
        const execution: ExecutionResult = {
          type: 'observe',
          name: call.name,
          error: {
            code: 'APPROVAL_REJECTED',
            message: `Approval for "${call.name}" was rejected`,
          },
        };
        const step = buildExecutionStep(state.iteration, call, execution);
        await deps?.recordStep?.(step);
        results.push(execution);
        steps.push(step);
        index++;
        continue;
      }

      if (!deps?.executeCall && !deps?.executor) {
        break;
      }

      // 遇到需要审批的调用立即设屏障，严禁提前触发后续工具调用
      if (!approved && deps.requiresApproval?.(call)) {
        try {
          const execution = await executeSingleCall(call, false);
          const step = buildExecutionStep(state.iteration, call, execution);
          await deps?.recordStep?.(step);
          results.push(execution);
          steps.push(step);
          index++;
          continue;
        } catch (error) {
          if (error instanceof CapabilityApprovalRequired) {
            return toPendingApprovalUpdate(results, steps, index, call, error);
          }
          throw error;
        }
      }

      // 聚合当前位置起连续的、无需审批且未被拒绝的安全并发批次
      let batchEnd = index + 1;
      if (concurrency > 1) {
        while (batchEnd < calls.length) {
          const candidate = calls[batchEnd];
          const candidateRejected = Boolean(state.rejectedCallId && state.rejectedCallId === candidate.id);
          const candidateApproved = Boolean(state.approvedCallId && state.approvedCallId === candidate.id);
          if (candidateRejected || (!candidateApproved && deps.requiresApproval?.(candidate))) {
            break;
          }
          batchEnd++;
        }
      }

      const batchSize = batchEnd - index;
      if (batchSize === 1) {
        let execution: ExecutionResult;
        try {
          execution = await executeSingleCall(call, approved);
        } catch (error) {
          if (error instanceof CapabilityApprovalRequired) {
            return toPendingApprovalUpdate(results, steps, index, call, error);
          }
          throw error;
        }
        const step = buildExecutionStep(state.iteration, call, execution);
        await deps?.recordStep?.(step);
        results.push(execution);
        steps.push(step);
        index++;
        continue;
      }

      // 受控并发池执行当前安全批次，并严格按原始 toolCalls 顺序回写步骤与结果
      const batchCalls = calls.slice(index, batchEnd);
      const batchOutcomes = new Array<{
        execution?: ExecutionResult;
        approvalError?: CapabilityApprovalRequired;
      }>(batchSize);
      let nextOffset = 0;
      let fatalError: unknown = null;
      let hasFatalError = false;

      const workerCount = Math.min(concurrency, batchSize);
      const runWorker = async () => {
        while (true) {
          if (hasFatalError || deps?.signal?.aborted) {
            return;
          }
          const offset = nextOffset++;
          if (offset >= batchSize) {
            return;
          }
          const item = batchCalls[offset];
          const itemApproved = Boolean(state.approvedCallId && state.approvedCallId === item.id);
          try {
            const execution = await executeSingleCall(item, itemApproved);
            batchOutcomes[offset] = { execution };
          } catch (error) {
            if (error instanceof CapabilityApprovalRequired) {
              batchOutcomes[offset] = { approvalError: error };
            } else {
              if (!hasFatalError) {
                hasFatalError = true;
                fatalError = error;
              }
              return;
            }
          }
        }
      };

      await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
      throwIfAborted(deps?.signal);
      if (hasFatalError) {
        throw fatalError;
      }

      for (let offset = 0; offset < batchSize; offset++) {
        const outcome = batchOutcomes[offset];
        const item = batchCalls[offset];
        if (outcome?.approvalError) {
          return toPendingApprovalUpdate(results, steps, index + offset, item, outcome.approvalError);
        }
        if (outcome?.execution) {
          const step = buildExecutionStep(state.iteration, item, outcome.execution);
          await deps?.recordStep?.(step);
          results.push(outcome.execution);
          steps.push(step);
        }
      }

      index = batchEnd;
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

function createValidateOutputNode(deps: Partial<AgentGraphDeps>) {
  const schema = deps.outputSchema!;
  const maxRetries = deps.maxOutputRetries ?? DEFAULT_MAX_OUTPUT_RETRIES;

  return async (state: AgentStateType): Promise<AgentStateUpdate> => {
    throwIfAborted(deps.signal);
    const rawOutput = state.finalAnswer ?? '';
    const check = validateStructuredOutput(schema, rawOutput);

    if (check.valid) {
      return {
        structuredOutput: check.value,
        finalAnswer: check.serialized,
        outputValidationDone: true,
      };
    }

    if (state.outputRepairRetries >= maxRetries || !deps.planner) {
      const error = {
        code: 'INVALID_STRUCTURED_OUTPUT',
        message: `Output failed outputSchema validation after ${state.outputRepairRetries} repair attempt(s): ${check.reason}`,
      };
      const finalStep: GraphStep = {
        type: 'final',
        node: 'validate-output',
        iteration: state.iteration,
        output: rawOutput,
        error,
        timestamp: new Date().toISOString(),
      };
      await deps.recordStep?.(finalStep);
      return {
        structuredOutput: undefined,
        finalAnswer: rawOutput,
        outputValidationDone: true,
        steps: [finalStep],
      };
    }

    const observeStep: GraphStep = {
      type: 'observe',
      node: 'validate-output',
      iteration: state.iteration,
      name: 'output-schema',
      output: { retry: state.outputRepairRetries + 1, maxRetries, reason: check.reason },
      error: {
        code: 'INVALID_STRUCTURED_OUTPUT',
        message: check.reason,
      },
      timestamp: new Date().toISOString(),
    };
    await deps.recordStep?.(observeStep);

    const halted = await startModelCall(state, deps, 'validate-output');
    if (halted) {
      const haltedSteps = Array.isArray(halted.steps) ? halted.steps : [];
      return {
        ...halted,
        structuredOutput: undefined,
        outputValidationDone: true,
        steps: [observeStep, ...haltedSteps],
      };
    }

    const iteration = state.iteration + 1;
    const repairPrompt = buildStructuredOutputRepairPrompt(schema, check.reason);
    const nextMessages: LlmMessage[] = [...state.messages, { role: 'user', content: repairPrompt }];
    const fallbackSteps: GraphStep[] = [];
    const startedAt = Date.now();
    const result = await deps.planner.plan(nextMessages, [], {
      model: deps.agentModel,
      ...(deps.agentFallbacks ? { fallbacks: deps.agentFallbacks } : {}),
      ...(deps.agentLlmOptions ?? {}),
      signal: deps.signal,
      onFallback: async (event) => {
        const fallbackStep = buildFallbackStep('validate-output', iteration, event);
        fallbackSteps.push(fallbackStep);
        await deps.recordStep?.(fallbackStep);
      },
    });
    const modelDurationMs = Math.max(0, Date.now() - startedAt);
    throwIfAborted(deps.signal);

    const repairedText = result.toolCalls?.length ? '' : (result.finalAnswer ?? '');
    const usage = isTokenUsage(result.usage) ? result.usage : null;
    const repairStep: GraphStep = {
      type: 'plan',
      node: 'validate-output',
      planner: 'langchain',
      iteration,
      ...(result.model ? { model: result.model } : {}),
      output: { type: 'final', output: repairedText },
      usage,
      modelDurationMs,
      timestamp: new Date().toISOString(),
    };
    await deps.recordStep?.(repairStep);

    const assistantMsg: LlmMessage = result.response ?? { role: 'assistant', content: repairedText };
    return {
      iteration,
      messages: [...nextMessages, assistantMsg],
      finalAnswer: repairedText,
      outputRepairRetries: state.outputRepairRetries + 1,
      outputValidationDone: false,
      steps: [observeStep, ...fallbackSteps, repairStep],
    };
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
  const hasOutputSchema = Boolean(deps?.outputSchema);
  const finishTarget = (state: AgentStateType): 'validate-output' | typeof END => (
    !state.isMaxIterationError && !state.outputValidationDone ? 'validate-output' : END
  );

  if (hasOutputSchema) {
    const validatedGraph = new StateGraph(AgentStateAnnotation)
      .addNode('plan', createPlanNode(deps))
      .addNode('execute', createExecuteNode(deps))
      .addNode('observe', createObserveNode(deps))
      .addNode('validate-output', createValidateOutputNode(deps!))
      .addConditionalEdges('execute', routeAfterExecute, { observe: 'observe', [END]: END })
      .addEdge('observe', 'plan')
      .addConditionalEdges(
        'validate-output',
        state => (state.outputValidationDone || state.isMaxIterationError ? END : 'validate-output'),
        { 'validate-output': 'validate-output', [END]: END },
      );

    if (deps?.mode === 'plan-and-execute') {
      return validatedGraph
        .addNode('make-plan', createTaskPlanningNode(deps))
        .addNode('synthesize', createSynthesisNode(deps))
        .addEdge(START, deps.startFromExecute ? 'execute' : 'make-plan')
        .addConditionalEdges('make-plan', state => (state.finalAnswer !== undefined ? END : 'plan'), [END, 'plan'])
        .addConditionalEdges('plan', state => {
          if (state.finalAnswer !== undefined) return END;
          if (state.toolCalls?.length) return 'execute';
          return state.taskIndex < state.taskPlan.length ? 'plan' : 'synthesize';
        }, [END, 'execute', 'plan', 'synthesize'])
        .addConditionalEdges('synthesize', finishTarget, { 'validate-output': 'validate-output', [END]: END })
        .compile();
    }

    if (deps?.mode === 'reflection') {
      return validatedGraph
        .addNode('review', createReviewNode(deps))
        .addEdge(START, deps.startFromExecute ? 'execute' : 'plan')
        .addConditionalEdges('plan', state => {
          if (state.isMaxIterationError) return END;
          return state.finalAnswer !== undefined ? 'review' : 'execute';
        }, [END, 'review', 'execute'])
        .addConditionalEdges(
          'review',
          state => (state.finalAnswer !== undefined ? finishTarget(state) : 'plan'),
          [END, 'plan', 'validate-output'],
        )
        .compile();
    }

    return validatedGraph
      .addEdge(START, deps?.startFromExecute ? 'execute' : 'plan')
      .addConditionalEdges(
        'plan',
        state => (state.finalAnswer !== undefined ? finishTarget(state) : 'execute'),
        { execute: 'execute', 'validate-output': 'validate-output', [END]: END },
      )
      .compile();
  }

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
      .addConditionalEdges('make-plan', state => (state.finalAnswer !== undefined ? END : 'plan'), [END, 'plan'])
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
      .addConditionalEdges('review', state => (state.finalAnswer !== undefined ? END : 'plan'), [END, 'plan'])
      .compile();
  }

  return graph
    .addEdge(START, deps?.startFromExecute ? 'execute' : 'plan')
    .addConditionalEdges('plan', routeAfterPlan, { execute: 'execute', [END]: END })
    .compile();
}

export const defaultAgentGraph = createAgentGraph();
