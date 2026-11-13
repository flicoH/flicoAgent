import { ConflictException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { SerialByKey } from '../../../common/async/serial-by-key';
import { ConfigService } from '../../../config/config.service';
import type { AgentDefinition } from '../../agent/agent.interface';
import { AgentScannerService } from '../../agent/agent-scanner.service';
import { GuardrailService } from '../../guardrail/guardrail.service';
import { LlmMessage } from '../../contracts';
import { CheckpointService } from '../../memory/checkpoint.service';
import { ThreadService } from '../../memory/thread.service';
import { collectCitations } from '../../rag/citations';
import { DELEGATE_TOOL, delegateSchema, delegatable, type DelegationContext } from '../internal/delegation';
import type { RunContinuation } from '../internal/run-continuation';
import { ExecutorService, InvalidCapabilityInput } from '../../tool/executor.service';
import {
  ExecutionResult, RunResult, TraceRun,
  RuntimeEvent,
  Step,
} from '../../contracts';
import { SkillScannerService } from '../../skill/skill-scanner.service';
import type { ThreadCheckpoint, TraceListQuery } from '../../store/store.interface';
import { ToolRegistryService } from '../../tool/tool-registry.service';
import { TraceService } from '../../trace/trace.service';
import { resolveMaxIterations } from '../internal/load-runtime-config';
import { LangChainPlannerService, type LangChainToolCall } from '../langchain/langchain-planner.service';
import { AdaptedStructuredTool, SkillToolAdapter } from '../langchain/skill-tool.adapter';
import { createAgentGraph, defaultAgentGraph } from './agent.graph';
import type { AgentStateType, GraphStep } from './agent.state';

/** HTTP 入口传入已验证的权限范围。对子运行追加的委派上下文由编排器内部构造。 */
interface RunOptions {
  scope?: string;
  signal?: AbortSignal;
  agents?: readonly string[];
  delegation?: DelegationContext;
}

type EmitRuntimeEvent = (event: RuntimeEvent) => void | Promise<void>;

/**
 * 单段执行上下文。首次运行从 plan 开始，审批通过或拒绝后使用同一 runId 开启恢复段。
 * decision 供恢复后的第一条工具调用消费，pause 由图写入并在退出后提交给 TraceStore。
 */
interface RunContext extends RunOptions {
  runId: string;
  agentName: string;
  delegation: DelegationContext;
  continuation?: RunContinuation;
  pause?: { approval: NonNullable<TraceRun['approval']>; continuation: RunContinuation };
  decision?: { approval: NonNullable<TraceRun['approval']>; approved: boolean };
  threadId: string;
  storageId: string;
  threadEnabled: boolean;
  emit?: EmitRuntimeEvent;
}

/** 按授权范围和 threadId 生成存储键。未指定授权范围的内部调用沿用原 threadId。 */
function resolveThreadStorageId(threadId: string, scope?: string): string {
  if (!scope) return threadId;
  const digest = createHash('sha256').update(JSON.stringify([scope, threadId])).digest('hex');
  return `scope-${digest}`;
}

/** 运行 API 不返回内部权限、进程元数据或可恢复快照。 */
export function publicResult(run: TraceRun): RunResult {
  const { runId, output, steps, threadId, status, failure, approval, usage, modelDurationMs, citations } = run;
  return { runId, output, steps, threadId, status, failure, approval, usage, modelDurationMs, citations };
}

/** 比较审批暂停前后的对话快照，包含消息内容和更新时间，避免恢复时覆盖其他轮次。 */
function memoryRevision(checkpoint: ThreadCheckpoint | null): string {
  return createHash('sha256').update(JSON.stringify(checkpoint)).digest('hex');
}

/**
 * 观察结果安全序列化辅助函数
 *
 * @param value 任意结果对象
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
 * 基于 LangGraph 的 Agent 编排引擎服务 (LangGraphOrchestratorService)
 *
 * 负责生产 Agent 入口、持久化运行状态与 LangGraph 调度。
 * 图负责单段的 plan → execute → observe；编排器负责在审批时结束这一段，
 * 并按快照恢复下一段。会话锁只保护正在执行的段，不跨人工审批等待。
 */
@Injectable()
export class LangGraphOrchestratorService {
  /** 技能与工具适配器实例 */
  private readonly adapter: SkillToolAdapter;
  /** 以当前编排器实例为界识别旧任务。已持久化的待审批运行可由新实例继续。 */
  private readonly workerId = randomUUID();
  private readonly logger = new Logger(LangGraphOrchestratorService.name);
  /** 仅登记本实例已进入执行流程的任务，排队状态的取消由持久化记录处理。 */
  private readonly active = new Map<string, AbortController>();
  // 提交后在本地有界工作队列运行。相同线程仍由 CheckpointService 保证串行。
  private readonly background = new SerialByKey();
  private nextLane = 0;
  private backgroundCount = 0;

  /**
   * 构造函数注入编排所需的核心服务
   *
   * @param agents Agent 扫描服务
   * @param skills 业务技能扫描服务
   * @param tools 通用工具注册表服务
   * @param planner LangChain 规划器服务
   * @param executor 能力调用执行器服务
   * @param trace 链路跟踪存储服务
   * @param threadService 多轮会话线程服务
   * @param checkpointService 会话检查点存储服务
   * @param guardrail 安全护栏拦截服务
   * @param config 全局统一配置服务
   */
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

  /**
   * 触发运行指定 Agent 任务（非流式同步返回）
   *
   * @param agentName 目标 Agent 的注册名称
   * @param input 初始输入数据（文本提问或结构化参数）
   * @param emitOrThreadId 可选的实时事件推送回调或 threadId
   * @param rawThreadId 可选的所属会话线程 ID
   * @param options 授权范围与取消信号
   * @returns 保证锁死合同结构 { runId, output, steps, threadId }
   */
  async run(
    agentName: string,
    input: unknown,
    emitOrThreadId?: ((event: RuntimeEvent) => void | Promise<void>) | string,
    rawThreadId?: string,
    options: RunOptions = {},
  ): Promise<RunResult> {
    const { emit, requestedThreadId } = this.resolveRunParams(emitOrThreadId, rawThreadId);
    const agent = this.requireAgent(agentName);
    options.signal?.throwIfAborted();
    const run = await this.createRun(agentName, input, requestedThreadId, options);
    return this.executeRun(run, agent, options, emit);
  }

  /** 先持久化 queued，再安排后台执行，响应连接与运行取消信号相互独立。 */
  async submit(agentName: string, input: unknown, threadId?: string, options: RunOptions = {}) {
    const agent = this.requireAgent(agentName);
    return this.enqueue(async () => {
      const run = await this.createRun(agentName, input, threadId, options);
      return { run, work: () => this.executeRun(run, agent, options) };
    });
  }

  async find(runId: string) {
    const run = await this.trace.load(runId);
    return run ? this.refresh(run) : null;
  }

  async list(query: TraceListQuery) {
    return Promise.all((await this.trace.list(query)).map(run => this.refresh(run)));
  }

  /** 单写进程模型：重启只恢复人工等待点，绝不自动重试可能已发生的副作用。 */
  async refresh(run: TraceRun) {
    if (!['queued', 'running'].includes(run.status ?? '') || run.workerId === this.workerId) return run;
    return this.trace.update(run.runId, latest => {
      if (!['queued', 'running'].includes(latest.status ?? '') || latest.workerId === this.workerId) return false;
      latest.status = 'interrupted';
      latest.failure = { code: 'RUN_INTERRUPTED', message: 'The worker stopped before finishing this run' };
      delete latest.continuation;
      delete latest.approval;
    });
  }

  /**
   * 在 Trace 写锁内检查最新状态。重复取消沿用已取消记录，其他终态返回冲突。
   * 活动任务收到中止信号，排队任务开始时会读取取消状态，待审批任务的快照在此清除。
   */
  async cancel(runId: string) {
    return this.trace.update(runId, run => {
      if (run.status === 'cancelled') return false;
      if (!['queued', 'running', 'waiting_approval'].includes(run.status ?? '')) {
        throw new ConflictException('This run is not cancellable');
      }
      this.active.get(runId)?.abort();
      run.status = 'cancelled';
      delete run.continuation;
      delete run.approval;
    });
  }

  /** 决策与状态转换原子提交。相同审批 ID 一旦被领取，其他请求无法再次执行。 */
  async decide(runId: string, approvalId: string, approved: boolean, agents?: readonly string[]) {
    return this.enqueue(async () => {
      let previous!: RunContinuation;
      let pending!: NonNullable<TraceRun['approval']>;
      const run = await this.trace.update(runId, latest => {
        if (latest.status !== 'waiting_approval' || latest.approval?.id !== approvalId || !latest.continuation) {
          throw new ConflictException('Approval is no longer pending');
        }
        this.requireAgent(latest.agent);
        previous = latest.continuation;
        pending = latest.approval;
        latest.steps.push({
          type: 'approval', iteration: previous.iteration, name: pending.name,
          output: { id: approvalId, decision: approved ? 'approved' : 'rejected' },
          timestamp: new Date().toISOString(),
        });
        // 在同一笔写入中记录决定并领取快照。后续请求将看到 queued，旧审批 ID 随即失效。
        latest.status = 'queued';
        latest.workerId = this.workerId;
        delete latest.continuation;
        delete latest.approval;
      });
      const agent = this.requireAgent(run.agent);
      // 恢复取原运行和当前审批者的权限交集；审批者不能扩大原运行的委派范围。
      const allowed = previous.agents?.filter(name => !agents || agents.includes(name)) ?? agents;
      const work = () => this.executeRun(run, agent, { scope: run.scope, agents: allowed },
        undefined, previous, { approval: pending, approved });
      return { run, work };
    });
  }

  /** 在持久化提交或领取审批之前预留队列容量，饱和时调用方可原样重试。 */
  private async enqueue(prepare: () => Promise<{ run: TraceRun; work: () => Promise<RunResult> }>) {
    if (this.backgroundCount >= 100) {
      throw new HttpException('Agent run queue is full; retry later', HttpStatus.TOO_MANY_REQUESTS);
    }
    this.backgroundCount++;
    try {
      const { run, work } = await prepare();
      // 四条独立的串行队列循环接收任务。排队与执行共用容量，最终统一归还位置。
      const lane = String(this.nextLane++ % 4);
      void this.background.run(lane, work).catch(() => {
        // 错误已保存在 Trace 中；日志不记录模型异常原文或业务参数。
        this.logger.warn('Background Agent run did not complete');
      }).finally(() => { this.backgroundCount--; });
      return run;
    } catch (error) {
      this.backgroundCount--;
      throw error;
    }
  }

  private requireAgent(name: string) {
    const agent = this.agents.get(name);
    if (!agent) throw new NotFoundException(`Agent "${name}" is not registered`);
    return agent;
  }

  private createRun(agent: string, input: unknown, threadId: string | undefined, options: RunOptions) {
    return this.trace.createRun(agent, input, this.threadService.ensureThread(threadId), options.scope, {
      status: 'queued', workerId: this.workerId,
      parentRunId: options.delegation?.parentRunId, rootRunId: options.delegation?.rootRunId,
    });
  }

  /**
   * 驱动一次执行段并负责写入失败或取消状态。
   * 合并显式取消与上游信号。上游可以是即时 SSE 的连接，也可以是委派调用的父运行。
   * 启用记忆时，同一线程的模型执行与对话写入都受会话锁保护。进入待审批后释放锁。
   */
  private async executeRun(
    run: TraceRun, agent: AgentDefinition, options: RunOptions, emit?: EmitRuntimeEvent,
    continuation?: RunContinuation, decision?: RunContext['decision'],
  ): Promise<RunResult> {
    const { runId, threadId } = run;
    const abort = new AbortController();
    this.active.set(runId, abort);
    const signal = options.signal ? AbortSignal.any([abort.signal, options.signal]) : abort.signal;
    const storageId = resolveThreadStorageId(threadId, options.scope);
    const threadEnabled = !options.delegation?.parentRunId && this.threadService.isThreadEnabled();
    const context: RunContext = {
      ...options, runId, agentName: agent.name, threadId, storageId, threadEnabled, emit, signal,
      continuation, decision,
      delegation: options.delegation ?? {
        lineage: [agent.name],
        budget: continuation?.budget ?? { models: resolveMaxIterations(this.config) + 10, children: 4 },
      },
    };
    const turn = async () => {
      // 检查排队期间的取消。没有持久化 running 状态时不得进入执行图。
      const started = await this.trace.update(runId, latest => {
        if (latest.status === 'cancelled') return false;
        signal.throwIfAborted();
        latest.status = 'running';
      });
      if (started.status === 'cancelled') return publicResult(started);
      await emit?.({ type: 'start', runId, threadId });
      return this.runTurn(run, agent, context);
    };
    try {
      return await (threadEnabled ? this.checkpointService.runTurn(storageId, turn) : turn());
    } catch (error) {
      const ended = await this.trace.update(runId, latest => {
        if (latest.status === 'cancelled') return false;
        latest.status = signal.aborted ? 'cancelled' : 'failed';
        if (!signal.aborted) {
          latest.failure = latest.steps.at(-1)?.error?.code === 'MODEL_FAILED'
            ? { code: 'MODEL_FAILED', message: 'Agent model call failed' }
            : { code: 'RUN_FAILED', message: 'Agent execution failed; see the recorded steps' };
        }
      });
      if (ended.status === 'cancelled' && !options.signal?.aborted) return publicResult(ended);
      throw error;
    } finally {
      // 审批决定可能已启动同一 runId 的下一段，只移除自己注册的控制器。
      if (this.active.get(runId) === abort) this.active.delete(runId);
    }
  }

  /**
   * 首段执行先检查输入护栏，再构造模型消息。恢复段沿用审批时保存的消息，
   * 包括模型的工具请求和之前的上下文，保持同一轮工具调用的关联。
   * 图退出后在 Trace 写锁内提交待审批快照或终态，让取消与完成按写入顺序生效。
   */
  private async runTurn(run: TraceRun, agent: AgentDefinition, context: RunContext): Promise<RunResult> {
    const { runId, input, threadId } = run;
    const { storageId, threadEnabled, signal, emit, continuation } = context;
    signal?.throwIfAborted();
    if (!continuation) {
      const rejection = await this.handleGuardrail(runId, input, threadId, emit);
      if (rejection) return publicResult(await this.trace.update(runId, latest => {
        if (latest.status === 'cancelled') return false;
        latest.status = 'failed';
        latest.failure = { code: 'GUARDRAIL_BLOCKED', message: rejection.output };
      }));
    }

    const { checkpoint, contextMessages } = await this.loadHistoricalContext(threadEnabled, storageId);
    signal?.throwIfAborted();
    const userInputText = this.normalizeInputText(input);
    const messages = continuation?.messages ?? this.buildInitialMessages(agent.prompt, contextMessages, userInputText);
    const { finalState, steps, streamedFinal } = await this.invokeGraph(runId, agent, messages, context, checkpoint, run.steps);
    if (finalState.waiting) return publicResult(await this.trace.update(runId, latest => {
      if (latest.status === 'cancelled') return false;
      signal?.throwIfAborted();
      // 先让图退出，再发布待审批状态；审批者此时才可以启动下一段执行。
      latest.status = 'waiting_approval';
      latest.approval = context.pause!.approval;
      latest.continuation = context.pause!.continuation;
    }));
    const output = finalState.finalAnswer ?? '';

    if (!finalState.isMaxIterationError) {
      await this.recordFinalStep(runId, steps, finalState.iteration, output, emit);
    }
    if (!streamedFinal) await this.emitOutput(output, emit);
    // 只从本运行已记录的检索步骤和成功委派中收集来源，匹配最终答案使用的标记。
    const citations = collectCitations(output, steps.flatMap(step => step.citations ?? []));
    return publicResult(await this.trace.update(runId, async latest => {
      if (latest.status === 'cancelled') return false;
      signal?.throwIfAborted();
      // 等待期间若同一线程有新轮次，恢复时保留新历史，避免把旧上下文写回。
      const sameMemory = !continuation || continuation.memory?.revision === memoryRevision(checkpoint);
      if (sameMemory && !finalState.isMaxIterationError) {
        await this.persistCheckpoint(threadEnabled, checkpoint, storageId, userInputText, output);
      }
      latest.status = finalState.isMaxIterationError ? 'failed' : 'succeeded';
      if (finalState.isMaxIterationError) {
        latest.failure = steps.at(-1)?.error ?? { code: 'MAX_ITERATIONS', message: output };
      }
      if (citations.length) latest.citations = citations;
    }));
  }

  /**
   * 编译并执行本轮状态图，返回最终状态、已记录的步骤和回答是否已发送增量。
   * 同一个取消信号传递给图、模型和工具执行层。
   */
  private async invokeGraph(
    runId: string,
    agent: AgentDefinition,
    messages: LlmMessage[],
    context: RunContext,
    checkpoint: ThreadCheckpoint | null,
    priorSteps: Step[],
  ): Promise<{ finalState: AgentStateType; steps: Step[]; streamedFinal: boolean }> {
    const { agentName, threadId, scope, signal, emit, continuation, delegation } = context;
    const steps = [...priorSteps];
    let streamedFinal = false;
    const structuredTools = this.adapter.adaptForAgent(
      agent.skills,
      agent.tools.filter(name => name !== DELEGATE_TOOL),
      { runId, agent: agentName },
    );
    const targets = delegatable(agent, context.agents).filter(name => !delegation.lineage.includes(name));
    if (targets.length && delegation.lineage.length < 3 && delegation.budget.children > 0
      && !structuredTools.some(tool => tool.name === DELEGATE_TOOL)) {
      structuredTools.push(new AdaptedStructuredTool(
        DELEGATE_TOOL, `Delegate a focused task to: ${targets.join(', ')}`, delegateSchema,
        async () => { throw new Error('Delegation requires a managed run'); },
      ));
    }
    const maxIterations = continuation?.maxIterations ?? resolveMaxIterations(this.config);
    const graph = createAgentGraph({
      planner: this.planner,
      executor: this.executor,
      runId,
      agentName,
      agentModel: agent.model,
      allowed: agent,
      context: { scope, threadId },
      consumeModel: () => {
        if (delegation.budget.models <= 0) return false;
        delegation.budget.models--;
        return true;
      },
      executeCall: (state, call, completed) => this.executeCall(
        agent, context, state, call, completed, checkpoint,
      ),
      signal,
      onDelta: emit && (async content => {
        streamedFinal = true;
        await emit({ type: 'delta', content });
      }),
      resetDelta: emit && (async () => {
        streamedFinal = false;
        await emit({ type: 'delta_reset' });
      }),
      recordStep: (step: GraphStep) => this.recordStep(runId, steps, step, emit),
    });

    const finalState = await graph.invoke(
      {
        messages,
        tools: structuredTools,
        iteration: continuation?.iteration ?? 0,
        // 恢复时从 execute 进入。当前轮工具指令以及已完成结果必须一起还原。
        ...(continuation ? { resume: true, toolCalls: continuation.calls, executionResults: continuation.completed } : {}),
        maxIterations,
        steps: [],
      },
      {
        // 设置安全上限，确保状态图内部 recursionLimit 远高于业务循环迭代计数刹车
        recursionLimit: Math.max(100, (maxIterations + 1) * 10),
        signal,
      },
    );

    return { finalState, steps, streamedFinal };
  }

  /** 审批发生在业务执行前。挂起时将本轮游标和已完成结果与状态一起写入。 */
  private async executeCall(
    agent: AgentDefinition, context: RunContext, state: AgentStateType, call: LangChainToolCall,
    completed: AgentStateType['executionResults'], checkpoint: ThreadCheckpoint | null,
  ): Promise<ExecutionResult | null> {
    const { scope, runId, threadId, signal, delegation } = context;
    const denied = (code: string, message: string): ExecutionResult =>
      ({ type: 'observe', name: call.name, error: { code, message } });
    const decision = context.decision;
    context.decision = undefined; // 决策只适用于恢复时的第一个、已固定参数的调用。
    if (decision && !decision.approved) return denied('APPROVAL_REJECTED', 'The tool call was rejected');
    if (call.name === DELEGATE_TOOL) return this.delegate(agent, context, call);
    let kind: 'skill' | 'tool' | undefined;
    try {
      kind = this.executor.approvalFor(call.name, call.args, agent);
    } catch (error) {
      if (error instanceof InvalidCapabilityInput) return denied('INVALID_CAPABILITY_INPUT', error.message);
      throw error;
    }
    // 挂起期间部署可能更换工具或收紧白名单，批准前后必须仍匹配同名同类的审批能力。
    if (decision && (decision.approval.kind !== kind || decision.approval.name !== call.name)) {
      return denied('APPROVAL_STALE', 'The capability changed after the approval request');
    }
    if (kind && !decision) {
      if (delegation.parentRunId) return denied('APPROVAL_REQUIRED', 'Delegated runs cannot pause for approval');
      context.pause = {
        approval: { id: randomUUID(), kind, name: call.name, input: call.args },
        continuation: {
          messages: state.messages, iteration: state.iteration, maxIterations: state.maxIterations,
          calls: state.toolCalls ?? [], completed, budget: delegation.budget, agents: context.agents,
          memory: { revision: context.continuation?.memory?.revision ?? memoryRevision(checkpoint) },
        },
      };
      return null;
    }
    signal?.throwIfAborted();
    return this.executor.execute(call.name, call.args, {
      scope, threadId, runId, agent: agent.name, signal,
      // 业务实现可用该稳定 ID 作为下游幂等键。
      idempotencyKey: `${runId}:${state.iteration}:${completed.length}`,
    }, agent, decision ? kind : undefined);
  }

  /**
   * 校验委派目标和预算后创建子运行，子 Agent 的模型输入由子任务和自身提示词构成。
   * 父子共享计数对象和权限范围。祖先列表用于拦截循环，子运行的 Trace 独立记录耗时和用量。
   * 子运行结束后把结果转成父图中的工具观察。子任务失败由父模型收到错误并决定后续动作。
   */
  private async delegate(agent: AgentDefinition, context: RunContext, call: LangChainToolCall): Promise<ExecutionResult> {
    const args = call.args as { agent?: string; input?: unknown } | null;
    const target = args?.agent;
    const { delegation, runId, scope, signal } = context;
    const deny = (code: string) => ({
      type: 'observe' as const, name: call.name, error: { code, message: 'Agent delegation is unavailable' },
    });
    if (!args || Array.isArray(args) || Object.keys(args).length !== 2 || typeof target !== 'string' || !Object.hasOwn(args, 'input')) return deny('INVALID_CAPABILITY_INPUT');
    if (!delegatable(agent, context.agents).includes(target) || !this.agents.get(target)
      || delegation.lineage.includes(target)) return deny('DELEGATE_NOT_ALLOWED');
    if (delegation.lineage.length >= 3 || delegation.budget.children <= 0
      || delegation.budget.models <= 0) return deny('DELEGATE_BUDGET_EXCEEDED');
    // 创建子 Trace 前扣减预算，失败的子任务也占一次尝试，避免错误分支无限重试。
    delegation.budget.children--;
    const options = { scope, signal, agents: context.agents, delegation: {
      lineage: [...delegation.lineage, target], budget: delegation.budget,
      parentRunId: runId, rootRunId: delegation.rootRunId ?? runId,
    } };
    signal?.throwIfAborted();
    const child = await this.createRun(target, args.input, undefined, options);
    try {
      const result = await this.executeRun(child, this.requireAgent(target), options);
      if (result.status !== 'succeeded') return { ...deny(result.failure?.code ?? 'DELEGATE_FAILED'), childRunId: child.runId };
      return { type: 'tool', source: 'builtin', name: call.name, childRunId: child.runId,
        output: { runId: child.runId, output: result.output, citations: result.citations }, citations: result.citations };
    } catch {
      signal?.throwIfAborted();
      return { ...deny('DELEGATE_FAILED'), childRunId: child.runId };
    }
  }

  /**
   * 以异步迭代器形式流式执行指定 Agent 任务
   *
   * @param agentName 目标 Agent 的注册名称
   * @param input 初始输入数据
   * @param threadId 可选会话线程 ID
   * @returns 运行时事件流迭代器 (delta, step)
   */
  async *runStream(
    agentName: string,
    input: unknown,
    threadId?: string,
  ): AsyncIterable<RuntimeEvent> {
    const queue: RuntimeEvent[] = [];
    let resolveNext: (() => void) | null = null;
    let finished = false;
    let error: unknown = null;
    const abort = new AbortController();

    // 新事件到达或任务结束时都要唤醒可能正在等下一项的迭代器。
    const wakeReader = () => {
      resolveNext?.();
      resolveNext = null;
    };

    const task = this.run(agentName, input, event => {
      queue.push(event);
      wakeReader();
    }, threadId, { signal: abort.signal })
      .catch((err) => {
        error = err;
      })
      .finally(() => {
        finished = true;
        wakeReader();
      });

    try {
      while (!finished || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            resolveNext = resolve;
          });
        }
        while (queue.length > 0) yield queue.shift()!;
      }
      await task;
      if (error) throw error;
    } finally {
      if (!finished) abort.abort();
    }
  }

  /**
   * 获取 Agent 运行图拓扑结构
   * 对齐 GET /api/ai/agent/graph 端点合同
   *
   * @returns 拓扑结构 { nodes, edges }
   */
  getGraph(): {
    nodes: Array<{ id: string; name: string }>;
    edges: Array<{ source: string; target: string; conditional: boolean }>;
  } {
    const drawable = defaultAgentGraph.getGraph();
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

  /**
   * 解析 run 参数，归一化 emit 回调与 requestedThreadId
   *
   * @param emitOrThreadId 回调函数或线程 ID
   * @param rawThreadId 可选线程 ID
   * @returns 规整后的 emit 与 requestedThreadId
   */
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

  /**
   * 将输入规整为便于文本检索和护栏判断的字符串
   *
   * @param input 原始输入
   * @returns 规范化的字符串
   */
  private normalizeInputText(input: unknown): string {
    return typeof input === 'string' ? input : serializeObservation(input);
  }

  /**
   * 安全护栏拦截处理（位于循环最前端）
   * 若触发违规拦截，记录 guardrail 步骤并闭环返回
   *
   * @param runId 已建立的追踪 ID
   * @param input 输入参数
   * @param threadId 会话线程 ID
   * @param emit 实时事件推送回调
   * @returns 拦截时返回 RunResult，未拦截时返回 null
   */
  private async handleGuardrail(
    runId: string,
    input: unknown,
    threadId: string,
    emit?: (event: RuntimeEvent) => void | Promise<void>,
  ): Promise<RunResult | null> {
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
    await this.recordStep(runId, steps, guardStep, emit);
    await this.emitOutput(rejectionOutput, emit);
    return { runId, output: rejectionOutput, steps, threadId };
  }

  /**
   * 加载历史会话上下文
   * 读取 checkpoint 并通过滑动窗口截断
   *
   * @param threadEnabled 是否启用记忆
   * @param threadId 线程 ID
   * @returns 检查点与格式化上下文消息
   */
  private async loadHistoricalContext(
    threadEnabled: boolean,
    threadId: string,
  ): Promise<{
    checkpoint: ThreadCheckpoint | null;
    contextMessages: LlmMessage[];
  }> {
    const checkpoint = threadEnabled ? await this.checkpointService.load(threadId) : null;
    const historicalMessages = checkpoint ? this.threadService.truncate(checkpoint.messages) : [];
    const contextMessages = this.threadService.buildContextMessages({
      threadId,
      messages: historicalMessages,
      updatedAt: checkpoint?.updatedAt ?? Date.now(),
    });
    return { checkpoint, contextMessages };
  }

  /**
   * 初始化对话消息历史（拼接：system -> 历史上下文 -> 当前用户提问）
   *
   * @param agentPrompt Agent 系统提示词
   * @param contextMessages 历史上下文消息
   * @param userInputText 用户当前提问文本
   * @returns 组装好的消息列表
   */
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

  /**
   * 记录最终结束步骤
   *
   * @param runId 运行任务 ID
   * @param steps 内存步骤数组
   * @param iteration 结束时的轮次
   * @param output 最终产出文本
   * @param emit 实时事件推送回调
   */
  private async recordFinalStep(
    runId: string,
    steps: Step[],
    iteration: number,
    output: string,
    emit?: (event: RuntimeEvent) => void | Promise<void>,
  ): Promise<void> {
    const finalStep: GraphStep = {
      type: 'final',
      node: 'plan',
      iteration,
      output,
      timestamp: new Date().toISOString(),
    };
    await this.recordStep(runId, steps, finalStep, emit);
  }

  /**
   * 落盘持久化保存会话检查点
   *
   * @param threadEnabled 是否启用记忆
   * @param checkpoint 已有检查点
   * @param threadId 线程 ID
   * @param userInputText 用户问题
   * @param finalOutput 最终回答
   */
  private async persistCheckpoint(
    threadEnabled: boolean,
    checkpoint: ThreadCheckpoint | null,
    threadId: string,
    userInputText: string,
    finalOutput: string,
  ): Promise<void> {
    if (!threadEnabled) {
      return;
    }
    const baseCheckpoint: ThreadCheckpoint = checkpoint ?? {
      threadId,
      messages: [],
      updatedAt: Date.now(),
    };
    const updatedCheckpoint = this.threadService.appendTurn(baseCheckpoint, userInputText, finalOutput, threadId);
    updatedCheckpoint.messages = this.threadService.truncate(updatedCheckpoint.messages);
    await this.checkpointService.save(updatedCheckpoint);
  }

  /**
   * 依次追加内存数组、写入 TraceStore 并触发事件
   *
   * @param runId 运行任务 ID
   * @param steps 内存步骤数组
   * @param step 待记录步骤
   * @param emit 实时事件推送回调
   */
  private async recordStep(
    runId: string,
    steps: Step[],
    step: Step,
    emit?: (event: RuntimeEvent) => void | Promise<void>,
  ): Promise<void> {
    steps.push(step);
    await this.trace.addStep(runId, step);
    await emit?.({ type: 'step', step });
  }

  /**
   * 推送无模型增量的结果，例如 Guardrail 提示。
   *
   * @param output 最终文本答案
   * @param emit 实时事件推送回调
   */
  private async emitOutput(
    output: string,
    emit?: (event: RuntimeEvent) => void | Promise<void>,
  ): Promise<void> {
    if (output) await emit?.({ type: 'delta', content: output });
  }
}
