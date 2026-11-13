import { Injectable } from '@nestjs/common';
import { AgentScannerService } from '../agent/agent-scanner.service';
import { GuardrailService } from '../guardrail/guardrail.service';
import { LlmMessage } from '../llm/llm.interface';
import { CheckpointService } from '../memory/checkpoint.service';
import { ThreadService } from '../memory/thread.service';
import { SkillScannerService } from '../skill/skill-scanner.service';
import { ThreadCheckpoint } from '../store/store.interface';
import { ToolRegistryService } from '../tool/tool-registry.service';
import { TraceService } from '../trace/trace.service';
import { ExecutorService } from './executor.service';
import { PlannerService } from './planner.service';
import {
  MAX_ITERATIONS,
  RunResult,
  RuntimeEvent,
  Step,
} from './runtime.types';

/**
 * 将任意观察结果安全序列化为大模型可理解的文本字符串
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
 * Agent 运行时编排服务 (OrchestratorService)
 *
 * 【核心 ReAct 引擎】
 * 驱动通用的 ReAct (Reasoning + Acting) 思考与执行循环，完全独立于具体业务：
 * 1. 资源装配：从 AgentScanner 加载指定 Agent 声明，筛选其白名单内的 Skill 与 Tool 构成 tools 描述；
 * 2. 消息初始化：拼接 System Prompt 与初始用户输入；
 * 3. 循环迭代（最大 MAX_ITERATIONS 次）：
 *    - 调用预留的 Guardrail 钩子（当前为空实现）；
 *    - Planner 基于历史上下文进行决策规划；
 *    - 会话状态更新：追加 assistant 消息至上下文；
 *    - 决策分流：
 *      * 若 action 为 final：记录最终步骤，流式推流 output，闭合返回；
 *      * 若 action 为 invoke：调用 Executor 执行具体能力；
 *    - 观察结果回填：构造 tool 消息并挂钩对应 tool_call_id 追加至会话上下文；
 *    - 步骤记录：全量同步写入 TraceStore 持久化并向 SSE 发送实时事件；
 * 4. 边界处理：超过最大迭代轮次后优雅结束，避免死循环。
 */
@Injectable()
export class OrchestratorService {
  /**
   * 构造函数注入所有必需的核心服务
   * @param agents Agent 扫描服务
   * @param skills 业务技能扫描服务
   * @param tools 通用工具注册表
   * @param planner 单步规划决策服务
   * @param executor 能力调用执行器
   * @param trace 链路跟踪持久化服务
   */
  constructor(
    private readonly agents: AgentScannerService,
    private readonly skills: SkillScannerService,
    private readonly tools: ToolRegistryService,
    private readonly planner: PlannerService,
    private readonly executor: ExecutorService,
    private readonly trace: TraceService,
    private readonly threadService: ThreadService,
    private readonly checkpointService: CheckpointService,
    private readonly guardrail: GuardrailService,
  ) {}

  /**
   * 触发运行指定 Agent 的任务
   *
   * @param agentName 目标 Agent 的注册名称
   * @param input 初始输入数据（文本提问或结构化参数）
   * @param emitOrThreadId 可选的实时事件推送回调或 threadId
   * @param rawThreadId 可选的所属会话线程 ID
   * @returns 保证锁死合同结构 { runId, output, steps, threadId }
   */
  async run(
    agentName: string,
    input: unknown,
    emitOrThreadId?: ((event: RuntimeEvent) => void | Promise<void>) | string,
    rawThreadId?: string,
  ): Promise<RunResult> {
    const emit = typeof emitOrThreadId === 'function' ? emitOrThreadId : undefined;
    const requestedThreadId = typeof emitOrThreadId === 'string' ? emitOrThreadId : rawThreadId;

    const agent = this.agents.get(agentName);
    if (!agent) {
      throw new Error(`Agent "${agentName}" is not registered`);
    }

    // Thread 会话管理与线程标识确认
    const threadEnabled = this.threadService.isThreadEnabled();
    const threadId = this.threadService.ensureThread(requestedThreadId);

    // Guardrail 安全拦截校验（循环最前）
    const checkText = typeof input === 'string'
      ? input
      : (typeof input === 'object' && input !== null ? JSON.stringify(input) : String(input ?? ''));
    const guardrailCheck = this.guardrail.check(checkText);

    if (!guardrailCheck.safe) {
      const run = await this.trace.createRun(agentName, input, threadId);
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

    // 1. 严格按照 Agent 声明的白名单筛选开放的 Skill 与 Tool
    const skillTools = this.skills.toToolsPayload()
      .filter(item => agent.skills.includes(item.function.name));
    const registryTools = this.tools.list()
      .filter(tool => agent.tools.includes(tool.name))
      .map(tool => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    const tools = [...skillTools, ...registryTools];

    // 2. 历史检查点加载
    const checkpoint = threadEnabled ? await this.checkpointService.load(threadId) : null;
    const historicalMessages = checkpoint ? this.threadService.truncate(checkpoint.messages) : [];
    const contextMessages = this.threadService.buildContextMessages({
      threadId,
      messages: historicalMessages,
      updatedAt: checkpoint?.updatedAt ?? Date.now(),
    });

    // 3. 初始化对话消息历史：system -> 历史上下文 -> 当前用户提问
    const messages: LlmMessage[] = [];
    if (agent.prompt) {
      messages.push({ role: 'system', content: agent.prompt });
    }
    messages.push(...contextMessages);
    const userInputText = typeof input === 'string' ? input : serializeObservation(input);
    messages.push({
      role: 'user',
      content: userInputText,
    });

    // 4. 创建初始 Trace 记录
    const run = await this.trace.createRun(agentName, input, threadId);
    const steps: Step[] = [];

    // 5. 进入 ReAct 主循环
    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1) {
      // 预留安全守卫钩子；当前实现不执行任何检查。
      this.applyGuardrail(messages);

      // 单轮决策规划
      const plan = await this.planner.plan(messages, tools, agent.model);

      // 将模型返回的原始 assistant 消息写回会话历史
      messages.push(plan.response);

      // 记录规划步骤
      await this.recordStep(run.runId, steps, {
        type: 'plan',
        iteration,
        output: plan.action,
        toolCallId: plan.toolCallId,
        timestamp: new Date().toISOString(),
      }, emit);

      // 分支一：规划器得出最终答案，正常结束运行
      if (plan.action.type === 'final') {
        const finalOutput = plan.action.output;
        const finalStep: Step = {
          type: 'final',
          iteration,
          output: finalOutput,
          timestamp: new Date().toISOString(),
        };
        await this.recordStep(run.runId, steps, finalStep, emit);
        await this.emitOutput(finalOutput, emit);

        // run 后：appendTurn -> truncate（落盘也不超 N）-> checkpoint.save
        // 仅在启用 threadEnabled 时保存检查点
        if (threadEnabled) {
          // 确保首轮会话（checkpoint 为空）时继承已确定的 threadId，避免重新随机生成 UUID 导致落盘文件名与返回给前端的 threadId 脱节
          const baseCheckpoint: ThreadCheckpoint = checkpoint ?? {
            threadId,
            messages: [],
            updatedAt: Date.now(),
          };
          const updatedCheckpoint = this.threadService.appendTurn(baseCheckpoint, userInputText, finalOutput, threadId);
          updatedCheckpoint.messages = this.threadService.truncate(updatedCheckpoint.messages);
          await this.checkpointService.save(updatedCheckpoint);
        }

        return { runId: run.runId, output: finalOutput, steps, threadId };
      }

      // 分支二：规划器决定调用能力
      const execution = await this.executor.execute(
        plan.action.name,
        plan.action.input,
        { runId: run.runId, agent: agentName },
      );
      const executionStep: Step = {
        type: execution.type,
        iteration,
        name: execution.name,
        ...(execution.source ? { source: execution.source } : {}),
        input: plan.action.input,
        output: execution.output,
        error: execution.error,
        toolCallId: plan.toolCallId,
        timestamp: new Date().toISOString(),
      };

      const observation = execution.error
        ? { error: execution.error }
        : { output: execution.output };
      const toolCallId = plan.toolCallId ?? `call-${iteration}`;

      // 严格按照 OpenAI 规范将观察结果作为 'tool' 消息回填至历史，以便模型进行下一轮推理
      messages.push({
        role: 'tool',
        tool_call_id: toolCallId,
        content: serializeObservation(observation),
      });

      // 记录执行步骤
      await this.recordStep(run.runId, steps, executionStep, emit);

      // 记录模型可见的观察事实步骤 (observe)
      if (execution.type !== 'observe') {
        await this.recordStep(run.runId, steps, {
          type: 'observe',
          iteration,
          name: execution.name,
          output: observation,
          toolCallId,
          timestamp: new Date().toISOString(),
        }, emit);
      }
    }

    // 6. 达到最大轮次安全熔断，保证返回与 Trace 处于闭环状态
    const output = `Agent reached the maximum of ${MAX_ITERATIONS} iterations`;
    await this.recordStep(run.runId, steps, {
      type: 'final',
      iteration: MAX_ITERATIONS,
      output,
      error: { code: 'MAX_ITERATIONS', message: output },
      timestamp: new Date().toISOString(),
    }, emit);
    await this.emitOutput(output, emit);

    if (threadEnabled) {
      // 确保首轮会话（checkpoint 为空）时继承已确定的 threadId，避免重新随机生成 UUID 导致落盘文件名与返回给前端的 threadId 脱节
      const baseCheckpoint: ThreadCheckpoint = checkpoint ?? {
        threadId,
        messages: [],
        updatedAt: Date.now(),
      };
      const updatedCheckpoint = this.threadService.appendTurn(baseCheckpoint, userInputText, output, threadId);
      updatedCheckpoint.messages = this.threadService.truncate(updatedCheckpoint.messages);
      await this.checkpointService.save(updatedCheckpoint);
    }

    return { runId: run.runId, output, steps, threadId };
  }

  /**
   * 以异步迭代器形式流式执行指定 Agent 任务
   *
   * @param agentName 目标 Agent 的注册名称
   * @param input 初始输入数据
   * @param threadId 可选会话线程 ID
   * @returns 运行时事件流迭代器
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

    const emit = (event: RuntimeEvent) => {
      queue.push(event);
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    };

    const task = this.run(agentName, input, emit, threadId)
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
   * 安全护栏拦截钩子（稳定扩展点，后续任务填充具体策略）
   *
   * @param messages 消息历史
   */
  private applyGuardrail(messages: LlmMessage[]): void {
    void messages;
  }

  /**
   * 依次追加内存数组、写入 TraceStore 并触发事件；存储或回调失败会向调用方传播。
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
   * 最终回答生成后，按 JavaScript 字符串迭代的 Unicode 码点推送 delta。
   * 这不是模型生成过程中的实时 token 流；回调按顺序等待。
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
