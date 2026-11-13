import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ConfigService } from '../config/config.service';
import { AgentScannerService } from './agent/agent-scanner.service';
import type { AiRequest } from './ai-access';
import { AgentRunRequestBody } from './ai.dto';
import { canReadRun, runSummary } from './run-http';
import { respondWithSse, sendRuntimeEvent } from './sse-response';
import { resolveMaxIterations } from './runtime/internal/load-runtime-config';
import { LangGraphOrchestratorService, publicResult } from './runtime/langgraph/langgraph-orchestrator.service';
import type { RunResult } from './contracts';
import { ToolRegistryService } from './tool/tool-registry.service';
import { TraceService } from './trace/trace.service';

/**
 * 同步和流式入口共用请求校验。在打开 SSE 响应前完成授权检查。
 *
 * @param body 请求体数据
 * @returns 规范化的 AgentRunRequestBody
 * @throws 当 agent 缺失或为空字符串时抛出 BadRequestException
 */
function resolveAgentRun(body: AgentRunRequestBody, request?: AiRequest): AgentRunRequestBody {
  if (!body || typeof body.agent !== 'string' || !body.agent.trim()) {
    throw new BadRequestException('agent is required');
  }
  if (body.input === undefined) {
    throw new BadRequestException('input is required');
  }
  const threadId = typeof body.threadId === 'string' && body.threadId.trim()
    ? body.threadId.trim()
    : undefined;
  const agent = body.agent.trim();
  assertAllowed(agent, request?.aiAccess?.agents);
  return { agent, input: body.input, ...(threadId ? { threadId } : {}) };
}

/** 未配置白名单时沿用调用方的默认权限，空白名单表示无权调用。 */
function assertAllowed(name: string, allowed?: readonly string[]): void {
  if (allowed !== undefined && (!Array.isArray(allowed) || !allowed.includes(name))) {
    throw new ForbiddenException('AI capability is not allowed');
  }
}

/**
 * AI 综合控制器 (AiController)
 *
 * 【安全与鉴权机制】
 * 路由挂载于 `/api/ai/*`，受全局 `ApiSignGuard` 保护，由业务授权或服务端请求签名确认身份，
 * 不进入免签白名单，确保线上生产调用的安全性。
 *
 * 【接口能力分布】
 * 1. Agent 任务执行：
 *    - POST `/api/ai/agent/run`：非流式 JSON 响应
 *    - POST `/api/ai/agent/run/stream`：SSE 流式实时事件推送（delta, step, done）
 *    - GET `/api/ai/agent/graph`：LangGraph Agent 状态图拓扑结构查询
 * 2. 运行链路查询：
 *    - GET `/api/ai/trace/:runId`：获取指定运行的完整步骤与事实记录
 * 3. 元数据资产查询：
 *    - GET `/api/ai/agent/list`：查询已注册 Agent 声明列表
 *    - GET `/api/ai/tool/list`：查询已注册 Tool 描述列表
 */
@Controller('api/ai')
export class AiController {
  /**
   * 构造函数注入所有 AI 子系统核心服务
   *
   * @param tools 通用工具注册表服务
   * @param agents Agent 纯声明元数据服务
   * @param orchestrator LangGraph Agent 编排引擎服务
   * @param trace 链路运行追踪与记录持久化服务
   * @param configService 全局配置服务
   */
  constructor(
    private readonly tools: ToolRegistryService,
    private readonly agents: AgentScannerService,
    private readonly orchestrator: LangGraphOrchestratorService,
    private readonly trace: TraceService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * 执行指定 Agent 并等待全流程结束（非流式）
   *
   * @param body 请求体包含 agent, input 以及可选的 threadId
   * @returns 保证锁死合同: { success: true, data: { runId, output, steps, threadId } }
   */
  @Post('agent/run')
  async runAgent(
    @Body() body: AgentRunRequestBody,
    @Req() request?: AiRequest,
  ): Promise<{ success: true; data: RunResult }> {
    const { agent, input, threadId } = resolveAgentRun(body, request);
    const result = await this.orchestrator.run(agent, input, undefined, threadId, { scope: request?.aiAccess?.scope, agents: request?.aiAccess?.agents });
    return { success: true, data: result };
  }

  /**
   * 执行指定 Agent 并通过 SSE (Server-Sent Events) 实时推送执行轨迹与增量文本
   *
   * 【SSE 事件流契约】
   * 1. `event: step`：每当产生 plan, tool, observe, final 步骤时实时推送该步骤数据；
   * 2. `event: delta`：推送上游增量。若同轮后来出现工具调用，发送 `delta_reset` 清除临时文本；
   * 3. `event: done`：流程完全闭合，推送与非流式端点同构的 `{ success: true, data: RunResult }` 载荷（含 threadId）。
   *
   * @param body 请求体
   * @param response Express 原始响应对象
   */
  @Post('agent/run/stream')
  async runAgentStream(
    @Body() body: AgentRunRequestBody,
    @Res() response: Response,
    @Req() request?: AiRequest,
  ): Promise<void> {
    const { agent, input, threadId } = resolveAgentRun(body, request);
    await respondWithSse(response, async (signal, send) => {
      const result = await this.orchestrator.run(
        agent, input, event => sendRuntimeEvent(event, send), threadId,
        { scope: request?.aiAccess?.scope, agents: request?.aiAccess?.agents, signal },
      );
      await send('done', { success: true, data: result });
    });
  }

  private isConcreteRunId(id: string) {
    return /^[a-zA-Z0-9_-]{1,128}$/.test(id) && !['latest', 'runId'].includes(id);
  }

  /**
   * 获取 LangGraph Agent 循环图拓扑（节点与连线）
   *
   * @returns 拓扑结构 { nodes, edges }
   */
  @Get('agent/graph')
  getAgentGraph(): { nodes: unknown; edges: unknown } {
    return this.orchestrator.getGraph();
  }

  /**
   * 根据 runId 查询历史运行追踪记录
   *
   * @param runId 运行任务 ID
   * @returns 包含完整 TraceRun 对象的响应
   * @throws 若记录不存在，返回业务错误码 40402
   */
  @Get('trace/:runId')
  async getTrace(@Param('runId') runId: string, @Req() request?: AiRequest) {
    const run = await this.findTraceOrThrow(runId, request?.aiAccess);
    return { success: true, data: { ...publicResult(run), ...runSummary(run), input: run.input } };
  }

  /**
   * 获取当前环境中所有已注册工具 (Tool) 的声明定义列表
   *
   * 【契约保护】
   * 仅返回可序列化的元数据（name, description, inputSchema, source），剔除本地 execute 实现
   *
   * @returns 工具定义数组
   */
  @Get('tool/list')
  listTools(): Array<{
    name: string;
    description: string;
    inputSchema: unknown;
    source?: string;
    approval?: 'required';
  }> {
    return this.tools.list().map(({ name, description, inputSchema, source, approval }) => ({
      name,
      description,
      inputSchema,
      ...(source ? { source } : {}),
      ...(approval ? { approval } : {}),
    }));
  }

  /**
   * 获取当前已发现并注册的 Agent 纯声明列表
   *
   * @returns Agent 声明数组
   */
  @Get('agent/list')
  listAgents(@Req() request?: AiRequest) {
    const allowed = request?.aiAccess?.agents;
    return this.agents.list().filter(agent => allowed === undefined || allowed.includes(agent.name));
  }

  /** 返回可公开的 Agent 运行配置。 */
  @Get('agent/config')
  getAgentConfig(): { maxIterations: number } {
    return { maxIterations: resolveMaxIterations(this.configService) };
  }

  /**
   * 查找指定的 Trace 运行记录，不存在时抛出业务 40402 异常
   *
   * @param runId 运行标识
   * @returns Trace 记录
   */
  private async findTraceOrThrow(runId: string, access?: AiRequest['aiAccess']) {
    // 禁止 HTTP 请求使用全局 latest 别名，以免读取其他调用方最近的运行。
    const validId = this.isConcreteRunId(runId);
    const run = validId ? await this.trace.load(runId) : null;
    if (!run || !canReadRun(run, access)) {
      throw new HttpException({
        success: false,
        message: `Trace "${runId}" does not exist`,
        code: 40402,
      }, HttpStatus.OK);
    }
    return this.orchestrator.refresh(run);
  }

}
