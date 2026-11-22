import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ConfigService } from '../../../config/config.service';
import type { AgentDefinition, AgentLoopMode } from '../../agent/agent.interface';
import { AgentScannerService } from '../../agent/agent-scanner.service';
import { GuardrailService } from '../../guardrail/guardrail.service';
import { LlmMessage } from '../../contracts';
import { CheckpointService } from '../../memory/checkpoint.service';
import { ThreadService } from '../../memory/thread.service';
import { ExecutorService } from '../../tool/executor.service';
import {
  AgentRunAccess,
  Citation,
  ExecutionResult,
  RunResult,
  TraceRun,
  RuntimeEvent,
  Step,
} from '../../contracts';
import { collectCitations } from '../../rag/citations';
import { resolveRagOptions } from '../../rag/internal/load-rag-config';
import { SkillScannerService } from '../../skill/skill-scanner.service';
import { ThreadCheckpoint } from '../../store/store.interface';
import { ToolRegistryService } from '../../tool/tool-registry.service';
import { summarizeTokenUsage } from '../../trace/token-usage';
import { TraceService } from '../../trace/trace.service';
import { resolveMaxIterations } from '../internal/load-runtime-config';
import { LangChainPlannerService } from '../langchain/langchain-planner.service';
import { AdaptedStructuredTool, SkillToolAdapter } from '../langchain/skill-tool.adapter';
import { createAgentGraph, defaultAgentGraph } from './agent.graph';
import type { GraphStep } from './agent.state';

const DELEGATE_TOOL = 'agent-delegate';
const SCOPED_CHECKPOINT_PREFIX = 'agent-scope-';
const SCOPED_CHECKPOINT_ID = /^agent-scope-[a-f0-9]{64}$/i;

interface DelegationBudget {
  remainingModelCalls: number;
  maxDepth: number;
  remainingChildRuns: number;
  allowedAgents?: readonly string[];
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
 * 【职责与定位】
 * 作为生产环境 HTTP 入口 (/api/ai/agent/run, /api/ai/agent/run/stream) 消费的编排引擎：
 * 1. 签名与 T5 OrchestratorService 保持 100% 一致；
 * 2. 循环编排委托给 LangGraph StateGraph (plan -> execute -> observe)；
 * 3. 循环上限由 resolveMaxIterations(this.config) 解析，禁止写死 5；
 * 4. 每个 graph 节点 addStep 时必须注入 node=plan|execute|observe，plan 步注入 planner=langchain；
 * 5. 安全护栏 Guardrail 仍在最前拦截；
 * 6. Thread / Checkpoint / Trace 保持与 T5 完全相同的接线位置与合同。
 */
@Injectable()
export class LangGraphOrchestratorService {
  /** 技能与工具适配器实例 */
  private readonly adapter: SkillToolAdapter;

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
   * @param access 业务鉴权层提供的运行访问范围
   * @returns 保证锁死合同结构 { runId, output, steps, threadId }
   */
  async run(
    agentName: string,
    input: unknown,
    emitOrThreadId?: ((event: RuntimeEvent) => void | Promise<void>) | string,
    rawThreadId?: string,
    access?: AgentRunAccess,
  ): Promise<RunResult> {
    const { emit, requestedThreadId } = this.resolveRunParams(emitOrThreadId, rawThreadId);

    const agent = this.agents.get(agentName);
    if (!agent) {
      throw new Error(`Agent "${agentName}" is not registered`);
    }

    if (agent.delegationOnly || (access?.agents && !access.agents.includes(agentName))) {
      throw new ForbiddenException(`Agent "${agentName}" cannot be run directly by this caller`);
    }

    const threadId = this.threadService.ensureThread(requestedThreadId);
    if (access?.scope === undefined && this.threadService.isThreadEnabled()) {
      const normalizedThreadId = decodeURIComponent(threadId).replace(/^\{|\}$/g, '').trim();
      if (SCOPED_CHECKPOINT_ID.test(normalizedThreadId)) {
        throw new BadRequestException('Invalid threadId');
      }
    }
    const run = await this.trace.createRun(agentName, input, threadId, { scope: access?.scope });
    const budget = agent.delegates?.length ? {
      remainingModelCalls: this.delegationLimit('maxModelCalls', resolveMaxIterations(this.config) + 10, 1),
      maxDepth: this.delegationLimit('maxDepth', 2, 0),
      remainingChildRuns: this.delegationLimit('maxChildRuns', 4, 0),
      allowedAgents: access?.agents?.slice(),
    } : undefined;
    return this.executeRun(agent, run, budget, [agentName], emit);
  }

  private async executeRun(
    agent: AgentDefinition,
    run: TraceRun,
    budget: DelegationBudget | undefined,
    ancestry: string[],
    emit?: (event: RuntimeEvent) => void | Promise<void>,
  ): Promise<RunResult> {
    const { input, threadId } = run;
    const agentName = agent.name;
    const threadEnabled = !run.parentRunId && this.threadService.isThreadEnabled();
    const guardrailRejection = await this.handleGuardrail(run, emit);
    if (guardrailRejection) {
      return guardrailRejection;
    }

    const checkpointId = run.scope === undefined
      ? threadId
      : SCOPED_CHECKPOINT_PREFIX + createHash('sha256').update(JSON.stringify([run.scope, threadId])).digest('hex');
    const { checkpoint, contextMessages } = await this.loadHistoricalContext(threadEnabled, checkpointId);
    const userInputText = this.normalizeInputText(input);
    const retrieveTool = resolveRagOptions(this.config).tool.name || 'retrieve';
    const citationInstructions = '使用知识库片段作为依据时，在对应的正文陈述后原样插入该片段的 citation 标记。只引用本轮检索且用于回答的证据。';
    const prompt = agent.tools.includes(retrieveTool)
      ? [agent.prompt, citationInstructions].filter(Boolean).join('\n\n')
      : agent.prompt;
    const messages = this.buildInitialMessages(prompt, contextMessages, userInputText);
    const steps: Step[] = [];

    // 4. 将 Agent 白名单内的 Skill 与 Tool（含 MCP）适配为 LangChain StructuredTool
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
        args => this.delegate(agent, run, budget, ancestry, args),
      ));
    }

    // 5. 解析动态循环迭代上限（禁止写死 5）
    const maxIterations = resolveMaxIterations(this.config);

    // 6. 构造并编译本轮运行的 Agent 循环图
    const graph = createAgentGraph({
      planner: this.planner,
      executor: this.executor,
      runId: run.runId,
      agentName,
      agentModel: agent.model,
      mode: agent.mode,
      maxReflectionRevisions: agent.maxReflectionRevisions,
      takeModelCall: budget ? () => {
        if (budget.remainingModelCalls <= 0) {
          return false;
        }
        budget.remainingModelCalls--;
        return true;
      } : undefined,
      executeCall: call => call.name === DELEGATE_TOOL
        ? this.delegate(agent, run, budget, ancestry, call.args)
        : this.executor.execute(call.name, call.args, {
          runId: run.runId, agent: agentName, parentRunId: run.parentRunId, scope: run.scope,
        }, agent, Boolean(run.parentRunId)),
      recordStep: async (step: GraphStep) => {
        if (step.type === 'final' && typeof step.output === 'string') {
          const citations = collectCitations(step.output, steps, retrieveTool);
          if (citations.length) step = { ...step, citations };
        }
        await this.recordStep(run.runId, steps, step, emit);
      },
    });

    // 7. 执行图推理循环
    const finalState = await graph.invoke(
      {
        messages,
        tools: structuredTools,
        iteration: 0,
        maxIterations,
        steps: [],
      },
      {
        // 设置安全上限，确保状态图内部 recursionLimit 远高于业务循环迭代计数刹车
        recursionLimit: Math.max(100, (maxIterations + 1) * 10),
      },
    );

    const finalOutput = finalState.finalAnswer ?? '';
    const lastStep = steps.at(-1);
    const citations = lastStep?.type === 'final'
      ? lastStep.citations ?? []
      : collectCitations(finalOutput, steps, retrieveTool);
    if (lastStep?.type !== 'final') {
      await this.recordFinalStep(run.runId, steps, finalState.iteration, finalOutput, citations, emit);
    }

    // 向 SSE 推送文本 delta 流
    await this.emitOutput(finalOutput, emit);

    // 8. 会话检查点保存（若开启）
    await this.persistCheckpoint(threadEnabled, checkpoint, checkpointId, userInputText, finalOutput);

    return {
      runId: run.runId,
      output: finalOutput,
      steps,
      threadId,
      usage: summarizeTokenUsage(steps),
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
    });
    try {
      const result = await this.executeRun(child, childRun, budget, [...ancestry, child.name]);
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
      return failure('DELEGATE_FAILED', 'Sub-agent execution failed', childRun.runId);
    }
  }

  /**
   * 以异步迭代器形式流式执行指定 Agent 任务
   *
   * @param agentName 目标 Agent 的注册名称
   * @param input 初始输入数据
   * @param threadId 可选会话线程 ID
   * @param access 业务鉴权层提供的运行访问范围
   * @returns 运行时事件流迭代器 (delta, step)
   */
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

  /**
   * 获取 Agent 运行图拓扑结构
   * 对齐 GET /api/ai/agent/graph 端点合同
   *
   * @returns 拓扑结构 { nodes, edges }
   */
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
   * @param run 当前运行记录
   * @param emit 实时事件推送回调
   * @returns 拦截时返回 RunResult，未拦截时返回 null
   */
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
   * @param citations 最终回答使用的知识库引用
   * @param emit 实时事件推送回调
   */
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
   * 最终回答生成后，按 JavaScript 字符串迭代的 Unicode 码点推送 delta
   *
   * @param output 最终文本答案
   * @param emit 实时事件推送回调
   */
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
