import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '../../../config/config.service';
import type { AgentDefinition, AgentLoopMode } from '../../agent/agent.interface';
import { AgentScannerService } from '../../agent/agent-scanner.service';
import {
  AgentRunAccess,
  Citation,
  ExecutionResult,
  LlmMessage,
  PendingApproval,
  RunContinuation,
  RunFailure,
  RunResult,
  RunStatus,
  RunSummary,
  RuntimeEvent,
  Step,
  TraceRun,
} from '../../contracts';
import { GuardrailService } from '../../guardrail/guardrail.service';
import { CheckpointService } from '../../memory/checkpoint.service';
import { computeScopedCheckpointId, isScopedCheckpointKey } from '../../memory/internal/token-budget';
import { ThreadService, type MemorySummarizer } from '../../memory/thread.service';
import { collectCitations } from '../../rag/citations';
import { resolveRagOptions } from '../../rag/internal/load-rag-config';
import { SkillScannerService } from '../../skill/skill-scanner.service';
import { ThreadCheckpoint, TraceListQuery } from '../../store/store.interface';
import { ExecutorService } from '../../tool/executor.service';
import { ToolRegistryService } from '../../tool/tool-registry.service';
import { summarizeTokenUsage } from '../../trace/token-usage';
import { TraceService } from '../../trace/trace.service';
import { resolveMaxIterations, resolveToolConcurrency } from '../internal/load-runtime-config';
import { buildStructuredOutputInstruction } from '../internal/structured-output';
import { LangChainPlannerService } from '../langchain/langchain-planner.service';
import { AdaptedStructuredTool, SkillToolAdapter } from '../langchain/skill-tool.adapter';
import { createAgentGraph, defaultAgentGraph } from './agent.graph';
import type { GraphStep } from './agent.state';

const DELEGATE_TOOL = 'agent-delegate';
const MAX_CONCURRENT_RUNS = 4;
const MAX_QUEUED_RUNS = 100;

const TERMINAL_STATUSES = new Set<RunStatus>(['succeeded', 'failed', 'cancelled', 'interrupted']);

interface DelegationBudget {
  remainingModelCalls: number;
  maxDepth: number;
  remainingChildRuns: number;
  allowedAgents?: string[];
}

interface BackgroundJob {
  runId: string;
  execute: (signal: AbortSignal) => Promise<void>;
}

export interface RunSubscriptionEvent {
  event: 'start' | 'step' | 'status' | 'done';
  data: unknown;
}

function serializeObservation(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

function withStatus<T extends HttpException>(error: T, status: number): T & { status: number } {
  return Object.assign(error, { status });
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && (error.name === 'AbortError' || (error as { code?: string }).code === 'ABORT_ERR');
}

function summarizeModelDuration(steps: Step[]): number {
  let total = 0;
  for (const step of steps) {
    if (typeof step.modelDurationMs === 'number' && Number.isFinite(step.modelDurationMs) && step.modelDurationMs >= 0) {
      total += Math.round(step.modelDurationMs);
    }
  }
  return total;
}

export function toRunSummary(run: TraceRun): RunSummary {
  return {
    runId: run.runId,
    agent: run.agent,
    threadId: run.threadId,
    status: run.status ?? 'succeeded',
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.usage ? { usage: run.usage } : {}),
    ...(typeof run.modelDurationMs === 'number' ? { modelDurationMs: run.modelDurationMs } : {}),
    ...(run.failure ? { failure: run.failure } : {}),
    ...(run.approval ? { approval: run.approval } : {}),
    ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
    ...(run.rootRunId ? { rootRunId: run.rootRunId } : {}),
  };
}

export function toPublicRunDetail(run: TraceRun): RunResult & RunSummary {
  const { scope: _scope, workerId: _workerId, continuation: _continuation, ...rest } = run;
  return {
    ...rest,
    status: rest.status ?? 'succeeded',
  };
}

@Injectable()
export class LangGraphOrchestratorService {
  private readonly adapter: SkillToolAdapter;
  private readonly workerId = randomUUID();
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly queuedJobs: BackgroundJob[] = [];
  private readonly subscribers = new Map<string, Set<(event: RunSubscriptionEvent) => void>>();
  private runningCount = 0;
  private reservedCount = 0;

  constructor(
    private readonly agents: AgentScannerService,
    private readonly skills: SkillScannerService,
    private readonly tools: ToolRegistryService,
    private readonly planner: LangChainPlannerService,
    private readonly executor: ExecutorService,
    private readonly trace: TraceService,
    private readonly threadService: ThreadService,
    private readonly checkpointService: CheckpointService,
    private readonly guardrail: GuardrailService,
    private readonly config: ConfigService,
  ) {
    this.adapter = new SkillToolAdapter(this.skills, this.tools);
  }

  async run(
    agentName: string,
    input: unknown,
    emitOrThreadId?: ((event: RuntimeEvent) => void | Promise<void>) | string,
    rawThreadId?: string,
    access?: AgentRunAccess,
  ): Promise<RunResult> {
    const { emit, requestedThreadId } = this.resolveRunParams(emitOrThreadId, rawThreadId);
    const { agent, threadId } = this.prepareAgentAccess(agentName, requestedThreadId, access);
    const run = await this.trace.createRun(agentName, input, threadId, { scope: access?.scope }, {
      status: 'running',
      workerId: this.workerId,
    });
    await emit?.({ type: 'start', runId: run.runId });

    const budget = this.createDelegationBudget(agent, access);
    const controller = new AbortController();
    this.activeControllers.set(run.runId, controller);
    try {
      const checkpointId = this.computeCheckpointId(run.scope, threadId);
      const threadEnabled = this.threadService.isThreadEnabled();
      const execute = () => this.executeRun(agent, run, budget, [agentName], emit, controller.signal);
      return threadEnabled && typeof this.checkpointService?.runTurn === 'function'
        ? await this.checkpointService.runTurn(checkpointId, execute)
        : await execute();
    } finally {
      this.activeControllers.delete(run.runId);
    }
  }

  async submit(
    agentName: string,
    input: unknown,
    threadId?: string,
    access?: AgentRunAccess,
  ): Promise<RunSummary> {
    const { agent, threadId: resolvedThreadId } = this.prepareAgentAccess(agentName, threadId, access);
    this.reserveQueueSlot();

    let run: TraceRun;
    try {
      run = await this.trace.createRun(agentName, input, resolvedThreadId, { scope: access?.scope }, {
        status: 'queued',
        workerId: this.workerId,
      });
    } catch (error) {
      this.releaseReservedSlot();
      throw error;
    }

    const budget = this.createDelegationBudget(agent, access);
    this.enqueueReservedJob({
      runId: run.runId,
      execute: async (signal) => {
        const current = await this.trace.load(run.runId);
        if (!current || current.status === 'cancelled') {
          return;
        }
        await this.markRunning(run.runId);
        const checkpointId = this.computeCheckpointId(run.scope, resolvedThreadId);
        const threadEnabled = this.threadService.isThreadEnabled();
        const task = () => this.executeRun(agent, current, budget, [agentName], undefined, signal);
        if (threadEnabled) {
          await this.checkpointService.runTurn(checkpointId, task);
        } else {
          await task();
        }
      },
    });

    return toRunSummary(run);
  }

  async find(runId: string, access?: AgentRunAccess): Promise<TraceRun | null> {
    const loaded = await this.trace.load(runId);
    if (!loaded) {
      return null;
    }
    if (access && !this.canAccessRun(loaded, access)) {
      return null;
    }
    return this.reconcileOrphanStatus(loaded);
  }

  async list(query: TraceListQuery): Promise<TraceRun[]> {
    const runs = await this.trace.list(query);
    const reconciled: TraceRun[] = [];
    for (const run of runs) {
      reconciled.push(await this.reconcileOrphanStatus(run));
    }
    return reconciled;
  }

  async cancel(runId: string, access?: AgentRunAccess): Promise<RunSummary> {
    const existing = await this.find(runId, access);
    if (!existing) {
      throw withStatus(new NotFoundException(`Run "${runId}" does not exist`), HttpStatus.NOT_FOUND);
    }
    const status = existing.status ?? 'succeeded';
    if (TERMINAL_STATUSES.has(status)) {
      throw withStatus(new ConflictException(`Run "${runId}" is already in terminal status "${status}"`), HttpStatus.CONFLICT);
    }

    const queueIndex = this.queuedJobs.findIndex(job => job.runId === runId);
    if (queueIndex !== -1) {
      this.queuedJobs.splice(queueIndex, 1);
      this.releaseReservedSlot();
    }

    const controller = this.activeControllers.get(runId);
    controller?.abort();

    const updated = await this.trace.updateRun(runId, (record) => {
      record.status = 'cancelled';
      delete record.approval;
      delete record.continuation;
    });
    this.notifySubscribers(runId, { event: 'status', data: { status: 'cancelled' } });
    this.notifySubscribers(runId, { event: 'done', data: { success: true, data: toPublicRunDetail(updated) } });
    return toRunSummary(updated);
  }

  async decide(
    runId: string,
    approvalId: string,
    approved: boolean,
    access?: AgentRunAccess,
  ): Promise<RunSummary> {
    if (access && access.approve !== true) {
      throw withStatus(new ForbiddenException('Caller is not permitted to approve runs'), HttpStatus.FORBIDDEN);
    }

    const existing = await this.find(runId, access);
    if (!existing) {
      throw withStatus(new NotFoundException(`Run "${runId}" does not exist`), HttpStatus.NOT_FOUND);
    }
    if (existing.status !== 'waiting_approval' || !existing.approval || !existing.continuation) {
      throw withStatus(new ConflictException(`Run "${runId}" is not waiting for approval`), HttpStatus.CONFLICT);
    }
    if (existing.approval.id !== approvalId) {
      throw withStatus(new ConflictException('Approval ID is invalid or already decided'), HttpStatus.CONFLICT);
    }

    const agent = this.agents.get(existing.agent);
    if (!agent) {
      throw withStatus(new ConflictException(`Agent "${existing.agent}" is no longer registered`), HttpStatus.CONFLICT);
    }
    if (access?.agents && !access.agents.includes(agent.name)) {
      throw withStatus(new ForbiddenException(`Agent "${agent.name}" is unavailable to this caller`), HttpStatus.FORBIDDEN);
    }

    this.reserveQueueSlot();

    let updated: TraceRun;
    const continuation = existing.continuation;
    const pendingApproval = existing.approval;
    const approvalStep: Step = {
      type: 'approval',
      iteration: continuation.iteration,
      name: pendingApproval.name,
      input: pendingApproval.input,
      output: { approvalId, approved },
      toolCallId: continuation.pendingCallId,
      timestamp: new Date().toISOString(),
    };

    try {
      updated = await this.trace.updateRun(runId, (record) => {
        if (record.status !== 'waiting_approval' || record.approval?.id !== approvalId) {
          throw withStatus(new ConflictException('Approval ID is invalid or already decided'), HttpStatus.CONFLICT);
        }
        record.steps.push(approvalStep);
        record.status = 'queued';
        record.workerId = this.workerId;
        delete record.approval;
      });
    } catch (error) {
      this.releaseReservedSlot();
      throw error;
    }

    this.notifySubscribers(runId, {
      event: 'step',
      data: { sequence: updated.steps.length, step: approvalStep },
    });
    this.notifySubscribers(runId, { event: 'status', data: { status: 'queued' } });

    this.enqueueReservedJob({
      runId,
      execute: async (signal) => {
        const current = await this.trace.load(runId);
        if (!current || current.status === 'cancelled') {
          return;
        }
        await this.markRunning(runId);
        await this.resumeFromContinuation(agent, current, continuation, approved, signal);
      },
    });

    return toRunSummary(updated);
  }

  async subscribe(
    runId: string,
    after: number,
    access: AgentRunAccess | undefined,
    listener: (event: RunSubscriptionEvent) => void,
  ): Promise<() => void> {
    const run = await this.find(runId, access);
    if (!run) {
      throw withStatus(new NotFoundException(`Run "${runId}" does not exist`), HttpStatus.NOT_FOUND);
    }

    const status = run.status ?? 'succeeded';
    listener({ event: 'start', data: { runId: run.runId, status } });

    for (let index = 0; index < run.steps.length; index++) {
      const sequence = index + 1;
      if (sequence > after) {
        listener({ event: 'step', data: { sequence, step: run.steps[index] } });
      }
    }

    if (TERMINAL_STATUSES.has(status)) {
      listener({ event: 'done', data: { success: true, data: toPublicRunDetail(run) } });
      return () => undefined;
    }

    if (status === 'waiting_approval' && run.approval) {
      listener({ event: 'status', data: { status, approval: run.approval } });
    }

    let set = this.subscribers.get(runId);
    if (!set) {
      set = new Set();
      this.subscribers.set(runId, set);
    }
    set.add(listener);

    return () => {
      const listeners = this.subscribers.get(runId);
      listeners?.delete(listener);
      if (listeners && listeners.size === 0) {
        this.subscribers.delete(runId);
      }
    };
  }

  private prepareAgentAccess(
    agentName: string,
    requestedThreadId?: string,
    access?: AgentRunAccess,
  ): { agent: AgentDefinition; threadId: string } {
    const agent = this.agents.get(agentName);
    if (!agent) {
      throw withStatus(new NotFoundException(`Agent "${agentName}" is not registered`), HttpStatus.NOT_FOUND);
    }
    if (agent.delegationOnly || (access?.agents && !access.agents.includes(agentName))) {
      throw withStatus(new ForbiddenException(`Agent "${agentName}" cannot be run directly by this caller`), HttpStatus.FORBIDDEN);
    }

    const threadId = this.threadService.ensureThread(requestedThreadId);
    if (access?.scope === undefined && this.threadService.isThreadEnabled()) {
      if (isScopedCheckpointKey(threadId)) {
        throw new BadRequestException('Invalid threadId');
      }
    }
    return { agent, threadId };
  }

  private createDelegationBudget(agent: AgentDefinition, access?: AgentRunAccess): DelegationBudget | undefined {
    if (!agent.delegates?.length) {
      return undefined;
    }
    return {
      remainingModelCalls: this.delegationLimit('maxModelCalls', resolveMaxIterations(this.config) + 10, 1),
      maxDepth: this.delegationLimit('maxDepth', 2, 0),
      remainingChildRuns: this.delegationLimit('maxChildRuns', 4, 0),
      allowedAgents: access?.agents?.slice(),
    };
  }

  private computeCheckpointId(scope: string | undefined, threadId: string): string {
    return computeScopedCheckpointId(scope, threadId);
  }

  private canAccessRun(run: TraceRun, access: AgentRunAccess): boolean {
    if (run.scope !== access.scope) {
      return false;
    }
    if (access.agents && !access.agents.includes(run.agent)) {
      return false;
    }
    return true;
  }

  private async reconcileOrphanStatus(run: TraceRun): Promise<TraceRun> {
    if ((run.status === 'queued' || run.status === 'running') && run.workerId && run.workerId !== this.workerId) {
      return this.trace.updateRun(run.runId, (record) => {
        if ((record.status === 'queued' || record.status === 'running') && record.workerId !== this.workerId) {
          record.status = 'interrupted';
          record.failure = {
            code: 'RUN_INTERRUPTED',
            message: 'Run was interrupted before completion',
          };
          delete record.continuation;
        }
      });
    }
    return run;
  }

  private reserveQueueSlot(): void {
    if (this.runningCount + this.reservedCount >= MAX_QUEUED_RUNS) {
      throw withStatus(
        new HttpException('Background run queue is full, retry later', HttpStatus.TOO_MANY_REQUESTS),
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.reservedCount++;
  }

  private releaseReservedSlot(): void {
    if (this.reservedCount > 0) {
      this.reservedCount--;
    }
  }

  private enqueueReservedJob(job: BackgroundJob): void {
    this.queuedJobs.push(job);
    this.drainQueue();
  }

  private drainQueue(): void {
    while (this.runningCount < MAX_CONCURRENT_RUNS && this.queuedJobs.length > 0) {
      const job = this.queuedJobs.shift()!;
      this.releaseReservedSlot();
      this.runningCount++;
      const controller = new AbortController();
      this.activeControllers.set(job.runId, controller);

      void (async () => {
        try {
          await job.execute(controller.signal);
        } catch (error) {
          if (isAbortError(error, controller.signal)) {
            const latest = await this.trace.load(job.runId);
            if (latest && latest.status !== 'cancelled') {
              const cancelled = await this.trace.updateRun(job.runId, (record) => {
                record.status = 'cancelled';
                delete record.approval;
                delete record.continuation;
              });
              this.notifySubscribers(job.runId, { event: 'status', data: { status: 'cancelled' } });
              this.notifySubscribers(job.runId, { event: 'done', data: { success: true, data: toPublicRunDetail(cancelled) } });
            }
          } else {
            const failure: RunFailure = {
              code: 'MODEL_FAILED',
              message: 'Agent execution failed',
            };
            const failed = await this.trace.updateRun(job.runId, (record) => {
              record.status = 'failed';
              record.failure = failure;
              delete record.approval;
              delete record.continuation;
            });
            this.notifySubscribers(job.runId, { event: 'status', data: { status: 'failed', failure } });
            this.notifySubscribers(job.runId, { event: 'done', data: { success: true, data: toPublicRunDetail(failed) } });
          }
        } finally {
          this.activeControllers.delete(job.runId);
          this.runningCount--;
          this.drainQueue();
        }
      })();
    }
  }

  private async markRunning(runId: string): Promise<void> {
    await this.trace.updateRun(runId, (record) => {
      if (record.status !== 'cancelled') {
        record.status = 'running';
        record.workerId = this.workerId;
      }
    });
    this.notifySubscribers(runId, { event: 'status', data: { status: 'running' } });
  }

  private notifySubscribers(runId: string, event: RunSubscriptionEvent): void {
    const listeners = this.subscribers.get(runId);
    if (!listeners?.size) {
      return;
    }
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // 忽略单个监听方写入异常
      }
    }
  }

  private async executeRun(
    agent: AgentDefinition,
    run: TraceRun,
    budget: DelegationBudget | undefined,
    ancestry: string[],
    emit?: (event: RuntimeEvent) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const { input, threadId } = run;
    const agentName = agent.name;
    const threadEnabled = !run.parentRunId && this.threadService.isThreadEnabled();
    const guardrailRejection = await this.handleGuardrail(run, emit);
    if (guardrailRejection) {
      if (typeof this.trace.updateRun === 'function') {
        const done = await this.trace.updateRun(run.runId, (record) => {
          record.status = 'succeeded';
          delete record.continuation;
          delete record.approval;
        });
        this.notifySubscribers(run.runId, { event: 'status', data: { status: 'succeeded' } });
        this.notifySubscribers(run.runId, { event: 'done', data: { success: true, data: toPublicRunDetail(done) } });
      }
      return { ...guardrailRejection, status: 'succeeded' };
    }

    const checkpointId = this.computeCheckpointId(run.scope, threadId);
    const { checkpoint, contextMessages } = await this.loadHistoricalContext(threadEnabled, checkpointId);
    const userInputText = this.normalizeInputText(input);
    const retrieveTool = resolveRagOptions(this.config).tool.name || 'retrieve';
    const citationInstructions = '使用知识库片段作为依据时，在对应的正文陈述后原样插入该片段的 citation 标记。只引用本轮检索且用于回答的证据。';
    const promptParts: string[] = [];
    if (agent.prompt) promptParts.push(agent.prompt);
    if (agent.tools.includes(retrieveTool)) promptParts.push(citationInstructions);
    if (agent.outputSchema) promptParts.push(buildStructuredOutputInstruction(agent.outputSchema));
    const prompt = promptParts.length ? promptParts.join('\n\n') : undefined;
    const messages = this.buildInitialMessages(prompt, contextMessages, userInputText);
    const maxIterations = resolveMaxIterations(this.config);

    return this.runGraphLifecycle({
      agent,
      run,
      steps: [...run.steps],
      initialState: {
        messages,
        iteration: 0,
        maxIterations,
        steps: [],
      },
      startFromExecute: false,
      budget,
      ancestry,
      threadEnabled,
      checkpointId,
      checkpoint,
      checkpointUpdatedAt: checkpoint?.updatedAt ?? 0,
      userInputText,
      retrieveTool,
      emit,
      signal,
    });
  }

  private async resumeFromContinuation(
    agent: AgentDefinition,
    run: TraceRun,
    continuation: RunContinuation,
    approved: boolean,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const retrieveTool = resolveRagOptions(this.config).tool.name || 'retrieve';
    const budget: DelegationBudget | undefined = continuation.budget
      ? { ...continuation.budget }
      : undefined;
    const ancestry = continuation.ancestry?.length ? [...continuation.ancestry] : [agent.name];

    return this.runGraphLifecycle({
      agent,
      run,
      steps: [...run.steps],
      initialState: {
        messages: continuation.messages,
        iteration: continuation.iteration,
        maxIterations: continuation.maxIterations,
        toolCalls: continuation.toolCalls,
        executionResults: continuation.executionResults,
        resumeIndex: continuation.pendingIndex,
        approvedCallId: approved ? continuation.pendingCallId : undefined,
        rejectedCallId: approved ? undefined : continuation.pendingCallId,
        taskPlan: continuation.taskPlan ?? [],
        taskIndex: continuation.taskIndex ?? 0,
        previousDraft: continuation.previousDraft,
        reflectionRevisions: continuation.reflectionRevisions ?? 0,
        steps: [],
      },
      startFromExecute: true,
      budget,
      ancestry,
      threadEnabled: Boolean(continuation.threadEnabled),
      checkpointId: continuation.checkpointId ?? this.computeCheckpointId(run.scope, run.threadId),
      checkpoint: null,
      checkpointUpdatedAt: continuation.checkpointUpdatedAt ?? 0,
      userInputText: continuation.userInputText ?? this.normalizeInputText(run.input),
      retrieveTool,
      emit: undefined,
      signal,
    });
  }

  private async runGraphLifecycle(params: {
    agent: AgentDefinition;
    run: TraceRun;
    steps: Step[];
    initialState: Record<string, unknown>;
    startFromExecute: boolean;
    budget: DelegationBudget | undefined;
    ancestry: string[];
    threadEnabled: boolean;
    checkpointId: string;
    checkpoint: ThreadCheckpoint | null;
    checkpointUpdatedAt: number;
    userInputText: string;
    retrieveTool: string;
    emit?: (event: RuntimeEvent) => void | Promise<void>;
    signal?: AbortSignal;
  }): Promise<RunResult> {
    const {
      agent, run, steps, initialState, startFromExecute, budget, ancestry,
      threadEnabled, checkpointId, checkpoint, checkpointUpdatedAt, userInputText,
      retrieveTool, emit, signal,
    } = params;
    const agentName = agent.name;
    const isDelegated = Boolean(run.parentRunId);

    const structuredTools = this.adapter.adaptForAgent(
      agent.skills.filter(name => name !== DELEGATE_TOOL),
      agent.tools.filter(name => name !== DELEGATE_TOOL),
      { runId: run.runId, agent: agentName },
    );

    const targets = [...new Set(agent.delegates)].filter(name => !ancestry.includes(name)
      && (!budget?.allowedAgents || budget.allowedAgents.includes(name)));
    if (budget && budget.remainingChildRuns > 0 && targets.length && ancestry.length <= budget.maxDepth) {
      structuredTools.push(new AdaptedStructuredTool(
        DELEGATE_TOOL,
        'Delegate a text task to a declared sub-agent and wait for its result.',
        {
          type: 'object',
          properties: { agent: { type: 'string', enum: targets }, input: { type: 'string' } },
          required: ['agent', 'input'],
          additionalProperties: false,
        },
        args => this.delegate(agent, run, budget, ancestry, args, signal),
      ));
    }

    let streamedFinalDelta = false;
    const onDelta = emit ? async (content: string) => {
      streamedFinalDelta = true;
      await emit({ type: 'delta', content });
    } : undefined;
    const resetDelta = emit ? async () => {
      streamedFinalDelta = false;
      await emit({ type: 'delta_reset' });
    } : undefined;

    const agentLlmOptions = {
      ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
      ...(agent.maxTokens !== undefined ? { maxTokens: agent.maxTokens } : {}),
      ...(agent.topP !== undefined ? { topP: agent.topP } : {}),
      ...(agent.timeoutMs !== undefined ? { timeoutMs: agent.timeoutMs } : {}),
      ...(agent.timeout !== undefined ? { timeout: agent.timeout } : {}),
    };

    const toolConcurrency = agent.toolConcurrency ?? resolveToolConcurrency(this.config);

    const graph = createAgentGraph({
      planner: this.planner,
      executor: this.executor,
      allowed: { skills: agent.skills, tools: agent.tools },
      toolConcurrency,
      requiresApproval: (call) => {
        if (call.name === DELEGATE_TOOL) {
          return false;
        }
        return this.executor.willRequireApproval(call.name, call.args, agent, isDelegated);
      },
      runId: run.runId,
      agentName,
      agentModel: agent.model,
      agentFallbacks: agent.fallbacks,
      ...(Object.keys(agentLlmOptions).length ? { agentLlmOptions } : {}),
      ...(agent.outputSchema ? { outputSchema: agent.outputSchema } : {}),
      ...(agent.maxOutputRetries !== undefined ? { maxOutputRetries: agent.maxOutputRetries } : {}),
      mode: agent.mode,
      maxReflectionRevisions: agent.maxReflectionRevisions,
      signal,
      startFromExecute,
      onDelta,
      resetDelta,
      takeModelCall: budget ? () => {
        if (budget.remainingModelCalls <= 0) {
          return false;
        }
        budget.remainingModelCalls--;
        return true;
      } : undefined,
      executeCall: (call, options) => {
        if (call.name === DELEGATE_TOOL) {
          return this.delegate(agent, run, budget, ancestry, call.args, signal);
        }
        const idempotencyKey = `${run.runId}:${call.id}`;
        return this.executor.execute(
          call.name,
          call.args,
          {
            runId: run.runId,
            agent: agentName,
            parentRunId: run.parentRunId,
            scope: run.scope,
            signal,
            idempotencyKey,
          },
          agent,
          isDelegated,
          { approved: options?.approved, checkApproval: !isDelegated },
        );
      },
      recordStep: async (step: GraphStep) => {
        if (step.type === 'final' && typeof step.output === 'string') {
          const citations = collectCitations(step.output, steps, retrieveTool);
          if (citations.length) step = { ...step, citations };
        }
        await this.recordStep(run.runId, steps, step, emit);
      },
    });

    const maxIterations = Number(initialState.maxIterations ?? resolveMaxIterations(this.config));
    const finalState = await graph.invoke(
      {
        ...initialState,
        tools: structuredTools,
      },
      {
        recursionLimit: Math.max(100, (maxIterations + 1) * 10),
      },
    );

    if (finalState.pendingApproval) {
      const pending = finalState.pendingApproval;
      const approval: PendingApproval = {
        id: pending.id,
        kind: pending.kind,
        name: pending.name,
        input: pending.input,
      };
      const continuation: RunContinuation = {
        iteration: finalState.iteration,
        maxIterations: finalState.maxIterations,
        messages: finalState.messages,
        toolCalls: (finalState.toolCalls ?? []).map(call => ({ id: call.id, name: call.name, args: call.args })),
        executionResults: finalState.executionResults ?? [],
        pendingIndex: pending.index,
        pendingKind: pending.kind,
        pendingCallId: pending.callId,
        taskPlan: finalState.taskPlan,
        taskIndex: finalState.taskIndex,
        previousDraft: finalState.previousDraft,
        reflectionRevisions: finalState.reflectionRevisions,
        checkpointUpdatedAt,
        checkpointId,
        threadEnabled,
        userInputText,
        ...(budget ? { budget: { ...budget } } : {}),
        ancestry,
      };

      const usage = summarizeTokenUsage(steps);
      const modelDurationMs = summarizeModelDuration(steps);
      await this.trace.updateRun(run.runId, (record) => {
        record.status = 'waiting_approval';
        record.approval = approval;
        record.continuation = continuation;
        record.modelDurationMs = modelDurationMs;
        if (usage) record.usage = usage;
      });
      await emit?.({ type: 'status', status: 'waiting_approval', approval });
      this.notifySubscribers(run.runId, { event: 'status', data: { status: 'waiting_approval', approval } });

      return {
        runId: run.runId,
        status: 'waiting_approval',
        approval,
        output: '',
        steps,
        threadId: run.threadId,
        ...(usage ? { usage } : {}),
        modelDurationMs,
      };
    }

    const finalOutput = finalState.finalAnswer ?? '';
    const lastStep = steps.at(-1);
    const citations = lastStep?.type === 'final'
      ? lastStep.citations ?? []
      : collectCitations(finalOutput, steps, retrieveTool);
    if (lastStep?.type !== 'final') {
      await this.recordFinalStep(run.runId, steps, finalState.iteration, finalOutput, citations, emit);
    }

    if (!streamedFinalDelta) {
      await this.emitOutput(finalOutput, emit);
    }

    await this.persistCheckpointSafely(
      threadEnabled,
      startFromExecute,
      checkpoint,
      checkpointId,
      checkpointUpdatedAt,
      userInputText,
      finalOutput,
      {
        publicThreadId: run.threadId,
        scope: run.scope,
        agent: agentName,
      },
    );

    const usage = summarizeTokenUsage(steps);
    const modelDurationMs = summarizeModelDuration(steps);
    const hasStructuredOutput = finalState.structuredOutput !== undefined;
    const saved = await this.trace.updateRun(run.runId, (record) => {
      record.status = 'succeeded';
      record.output = finalOutput;
      if (hasStructuredOutput) record.structuredOutput = finalState.structuredOutput;
      else delete record.structuredOutput;
      record.modelDurationMs = modelDurationMs;
      if (usage) record.usage = usage;
      if (citations.length) record.citations = citations;
      else delete record.citations;
      delete record.approval;
      delete record.continuation;
      delete record.failure;
    });

    this.notifySubscribers(run.runId, { event: 'status', data: { status: 'succeeded' } });
    this.notifySubscribers(run.runId, { event: 'done', data: { success: true, data: toPublicRunDetail(saved) } });

    return {
      runId: run.runId,
      status: 'succeeded',
      output: finalOutput,
      ...(hasStructuredOutput ? { structuredOutput: finalState.structuredOutput } : {}),
      steps,
      threadId: run.threadId,
      ...(usage ? { usage } : {}),
      modelDurationMs,
      ...(citations.length ? { citations } : {}),
    };
  }

  private delegationLimit(key: string, fallback: number, minimum: number): number {
    const value = this.config.get<number>(`ai.runtime.delegation.${key}`);
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum ? value : fallback;
  }

  private async delegate(
    parent: AgentDefinition,
    run: TraceRun,
    budget: DelegationBudget | undefined,
    ancestry: string[],
    args: unknown,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    const failure = (code: string, message: string, childRunId?: string): ExecutionResult => ({
      type: 'tool',
      name: DELEGATE_TOOL,
      ...(childRunId ? { childRunId } : {}),
      error: { code, message },
    });
    const request = args as { agent?: unknown; input?: unknown } | null;
    if (typeof request?.agent !== 'string' || typeof request.input !== 'string' || !request.input.trim()) {
      return failure('DELEGATE_INVALID_INPUT', 'Delegation requires an agent name and non-empty text input');
    }
    const child = this.agents.get(request.agent);
    if (!budget || !child || !parent.delegates?.includes(child.name)
      || (budget.allowedAgents && !budget.allowedAgents.includes(child.name))) {
      return failure('DELEGATE_NOT_ALLOWED', 'The requested sub-agent is unavailable to this Agent');
    }
    if (ancestry.includes(child.name)) {
      return failure('DELEGATE_CYCLE', 'Delegation would revisit an ancestor');
    }
    if (ancestry.length > budget.maxDepth) {
      return failure('DELEGATE_DEPTH_EXCEEDED', 'Delegation depth limit reached');
    }
    if (budget.remainingModelCalls <= 0) {
      return failure('DELEGATE_BUDGET_EXCEEDED', 'Agent tree reached its model call budget');
    }
    if (budget.remainingChildRuns <= 0) {
      return failure('DELEGATE_BUDGET_EXCEEDED', 'Agent tree reached its child run budget');
    }
    budget.remainingChildRuns--;

    const childRun = await this.trace.createRun(child.name, request.input, this.threadService.createThread(), {
      scope: run.scope,
      parentRunId: run.runId,
      rootRunId: run.rootRunId ?? run.runId,
      delegationDepth: ancestry.length,
    }, {
      status: 'running',
      workerId: this.workerId,
    });
    try {
      const result = await this.executeRun(child, childRun, budget, [...ancestry, child.name], undefined, signal);
      const lastStep = result.steps.at(-1);
      if (lastStep?.error || lastStep?.type === 'guardrail') {
        return failure(
          lastStep.error?.code ?? 'DELEGATE_GUARDRAIL',
          lastStep.error?.message ?? result.output,
          childRun.runId,
        );
      }
      return {
        type: 'tool',
        name: DELEGATE_TOOL,
        childRunId: childRun.runId,
        output: { agent: child.name, runId: childRun.runId, output: result.output },
      };
    } catch {
      await this.trace.addStep(childRun.runId, {
        type: 'final',
        iteration: 1,
        output: 'Sub-agent execution failed',
        error: { code: 'DELEGATE_FAILED', message: 'Sub-agent execution failed' },
        timestamp: new Date().toISOString(),
      });
      await this.trace.updateRun(childRun.runId, {
        status: 'failed',
        failure: { code: 'DELEGATE_FAILED', message: 'Sub-agent execution failed' },
      });
      return failure('DELEGATE_FAILED', 'Sub-agent execution failed', childRun.runId);
    }
  }

  async *runStream(
    agentName: string,
    input: unknown,
    threadId?: string,
    access?: AgentRunAccess,
  ): AsyncIterable<RuntimeEvent> {
    const queue: RuntimeEvent[] = [];
    let resolveNext: (() => void) | null = null;
    let finished = false;
    let error: unknown = null;

    const emit = (event: RuntimeEvent) => {
      queue.push(event);
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    };

    const task = this.run(agentName, input, emit, threadId, access)
      .then(() => {
        finished = true;
        if (resolveNext) {
          resolveNext();
          resolveNext = null;
        }
      })
      .catch((err) => {
        error = err;
        finished = true;
        if (resolveNext) {
          resolveNext();
          resolveNext = null;
        }
      });

    while (!finished || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }
      while (queue.length > 0) {
        yield queue.shift()!;
      }
    }

    await task;
    if (error) {
      throw error;
    }
  }

  getGraph(mode: AgentLoopMode = 'react'): {
    nodes: Array<{ id: string; name: string }>;
    edges: Array<{ source: string; target: string; conditional: boolean }>;
  } {
    const drawable = (mode === 'react' ? defaultAgentGraph : createAgentGraph({ mode })).getGraph();
    const nodes = Object.keys(drawable.nodes).map((id) => ({
      id,
      name: drawable.nodes[id]?.name || id,
    }));
    const edges = drawable.edges.map((e) => ({
      source: e.source,
      target: e.target,
      conditional: Boolean(e.conditional),
    }));
    return { nodes, edges };
  }

  private resolveRunParams(
    emitOrThreadId?: ((event: RuntimeEvent) => void | Promise<void>) | string,
    rawThreadId?: string,
  ): {
    emit?: (event: RuntimeEvent) => void | Promise<void>;
    requestedThreadId?: string;
  } {
    const emit = typeof emitOrThreadId === 'function' ? emitOrThreadId : undefined;
    const requestedThreadId = typeof emitOrThreadId === 'string' ? emitOrThreadId : rawThreadId;
    return { emit, requestedThreadId };
  }

  private normalizeInputText(input: unknown): string {
    return typeof input === 'string' ? input : serializeObservation(input);
  }

  private async handleGuardrail(
    run: TraceRun,
    emit?: (event: RuntimeEvent) => void | Promise<void>,
  ): Promise<RunResult | null> {
    const { input, threadId } = run;
    const checkText = typeof input === 'string'
      ? input
      : (typeof input === 'object' && input !== null ? JSON.stringify(input) : String(input ?? ''));
    const guardrailCheck = this.guardrail.check(checkText);

    if (guardrailCheck.safe) {
      return null;
    }

    const steps: Step[] = [];
    const rejectionOutput = guardrailCheck.reason || '输入内容触发安全规则，已被拦截。';
    const guardStep: Step = {
      type: 'guardrail',
      iteration: 1,
      output: rejectionOutput,
      timestamp: new Date().toISOString(),
    };
    await this.recordStep(run.runId, steps, guardStep, emit);
    await this.emitOutput(rejectionOutput, emit);
    return { runId: run.runId, output: rejectionOutput, steps, threadId };
  }

  private async loadHistoricalContext(
    threadEnabled: boolean,
    threadId: string,
  ): Promise<{
    checkpoint: ThreadCheckpoint | null;
    contextMessages: LlmMessage[];
  }> {
    const checkpoint = threadEnabled ? await this.checkpointService.load(threadId) : null;
    const historicalMessages = checkpoint ? this.threadService.truncate(checkpoint.messages) : [];
    const contextMessages = checkpoint
      ? this.threadService.buildContextMessages({
        ...checkpoint,
        threadId,
        messages: historicalMessages,
        updatedAt: checkpoint.updatedAt ?? Date.now(),
      })
      : [];
    return { checkpoint, contextMessages };
  }

  private buildInitialMessages(
    agentPrompt?: string,
    contextMessages: LlmMessage[] = [],
    userInputText: string = '',
  ): LlmMessage[] {
    const messages: LlmMessage[] = [];
    if (agentPrompt) {
      messages.push({ role: 'system', content: agentPrompt });
    }
    messages.push(...contextMessages);
    messages.push({
      role: 'user',
      content: userInputText,
    });
    return messages;
  }

  private async recordFinalStep(
    runId: string,
    steps: Step[],
    iteration: number,
    output: string,
    citations: Citation[],
    emit?: (event: RuntimeEvent) => void | Promise<void>,
  ): Promise<void> {
    const finalStep: GraphStep = {
      type: 'final',
      node: 'plan',
      iteration,
      output,
      ...(citations.length ? { citations } : {}),
      timestamp: new Date().toISOString(),
    };
    await this.recordStep(runId, steps, finalStep, emit);
  }

  private async persistCheckpointSafely(
    threadEnabled: boolean,
    isResumed: boolean,
    initialCheckpoint: ThreadCheckpoint | null,
    checkpointId: string,
    expectedUpdatedAt: number,
    userInputText: string,
    finalOutput: string,
    metadata?: { publicThreadId?: string; scope?: string; agent?: string },
  ): Promise<void> {
    if (!threadEnabled) {
      return;
    }
    const summarizer: MemorySummarizer = async (summaryMessages, options) => {
      if (typeof this.planner?.chat === 'function') {
        const res = await this.planner.chat(summaryMessages, { model: options.model });
        return res.output;
      }
      if (typeof this.planner?.plan === 'function') {
        const res = await this.planner.plan(summaryMessages, [], { model: options.model });
        return res.finalAnswer ?? '';
      }
      return '';
    };

    const save = async () => {
      const latest = await this.checkpointService.load(checkpointId);
      if (isResumed && latest && latest.updatedAt > expectedUpdatedAt) {
        // 等待审批期间同线程已有较新对话，禁止用旧审批结果覆写。
        return;
      }
      const baseCheckpoint: ThreadCheckpoint = latest ?? initialCheckpoint ?? {
        threadId: checkpointId,
        messages: [],
        updatedAt: 0,
      };
      const appended = this.threadService.appendTurn(
        baseCheckpoint,
        userInputText,
        finalOutput,
        checkpointId,
        metadata,
      );
      const compressed = typeof this.threadService.compressCheckpoint === 'function'
        ? await this.threadService.compressCheckpoint(appended, summarizer)
        : { ...appended, messages: this.threadService.truncate(appended.messages) };
      compressed.updatedAt = Math.max(Date.now(), (baseCheckpoint.updatedAt || 0) + 1);
      await this.checkpointService.save(compressed);
    };

    if (isResumed && typeof this.checkpointService?.runTurn === 'function') {
      await this.checkpointService.runTurn(checkpointId, save);
    } else {
      await save();
    }
  }

  private async recordStep(
    runId: string,
    steps: Step[],
    step: Step,
    emit?: (event: RuntimeEvent) => void | Promise<void>,
  ): Promise<void> {
    steps.push(step);
    await this.trace.addStep(runId, step);
    const sequence = steps.length;
    await emit?.({ type: 'step', step, sequence });
    this.notifySubscribers(runId, { event: 'step', data: { sequence, step } });
  }

  private async emitOutput(
    output: string,
    emit?: (event: RuntimeEvent) => void | Promise<void>,
  ): Promise<void> {
    if (!emit) {
      return;
    }
    for (const content of output) {
      await emit({ type: 'delta', content });
    }
  }
}
