import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { resolve } from 'node:path';
import { ConfigService } from '../config/config.service';
import { AgentScannerService } from './agent/agent-scanner.service';
import { LlmGateway } from './llm/llm.gateway';
import { LlmChatOptions, LlmMessage } from './llm/llm.interface';
import { resolveRagFixturesPath } from './rag/internal/load-rag-config';
import { RetrieverService } from './rag/retriever.service';
import { LangGraphOrchestratorService } from './lc-lg-runtime/langgraph/langgraph-orchestrator.service';
import { RunResult, RuntimeEvent } from './runtime/runtime.types';
import { SkillScannerService } from './skill/skill-scanner.service';
import { ToolRegistryService } from './tool/tool-registry.service';
import { TraceService } from './trace/trace.service';

/**
 * 普通大模型对话请求体定义
 */
interface ChatRequest extends LlmChatOptions {
  /** 单轮简单提问文本（优先级低于 messages） */
  message?: string;
  /** 完整的多轮消息列表 */
  messages?: LlmMessage[];
}

/**
 * Agent 运行通用请求体定义
 */
interface AgentRunRequest {
  /** 目标 Agent 的唯一注册名称 */
  agent: string;
  /** 初始输入内容（提问或参数对象） */
  input: unknown;
  /** 可选会话线程 ID，支持多轮上下文关联 */
  threadId?: string;
}

/**
 * 校验并提取 Agent 运行请求参数
 *
 * @param body 请求体数据
 * @returns 规范化的 AgentRunRequest
 * @throws 当 agent 缺失或为空字符串时抛出 BadRequestException
 */
function resolveAgentRun(body: AgentRunRequest): AgentRunRequest {
  if (!body || typeof body.agent !== 'string' || !body.agent.trim()) {
    throw new BadRequestException('agent is required');
  }
  const threadId = typeof body.threadId === 'string' && body.threadId.trim()
    ? body.threadId.trim()
    : undefined;
  return { agent: body.agent.trim(), input: body.input, ...(threadId ? { threadId } : {}) };
}

/**
 * 运行时判断返回值是否为异步迭代器（流式响应）
 *
 * @param value 待检测对象
 * @returns 是否为 AsyncIterable<string>
 */
function isAsyncIterable(value: unknown): value is AsyncIterable<string> {
  return value !== null
    && typeof value === 'object'
    && Symbol.asyncIterator in value;
}

/**
 * 将前端传来的单条 message 或完整 messages 归一化为标准的 LlmMessage 数组
 *
 * @param body 请求体
 * @returns LlmMessage 数组
 * @throws 两个字段均未提供时抛出 BadRequestException
 */
function resolveMessages(body: ChatRequest): LlmMessage[] {
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    return body.messages;
  }
  if (typeof body.message === 'string' && body.message.trim()) {
    return [{ role: 'user', content: body.message }];
  }
  throw new BadRequestException('message or messages is required');
}

/**
 * AI 综合控制器 (AiController)
 *
 * 【安全与鉴权机制】
 * 路由挂载于 `/api/ai/*`，受框架全局 `ApiSignGuard` 校验保护（施工单密钥 + 时间戳签名），
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
 * 4. 业务能力单点调试：
 *    - POST `/api/ai/skill/:name/invoke`：直接触发执行指定业务 Skill
 * 5. 底层大模型直接调用：
 *    - POST `/api/ai/chat`：同步多轮对话
 *    - POST `/api/ai/chat/stream`：SSE 文本流多轮对话
 * 6. RAG 知识库灌库：
 *    - POST `/api/ai/rag/ingest`：文档切片并向量化灌库
 */
@Controller('api/ai')
export class AiController {
  /**
   * 构造函数注入所有 AI 子系统核心服务
   *
   * @param llm 大模型网关服务
   * @param skills 业务技能扫描与注册服务
   * @param tools 通用工具注册表服务
   * @param agents Agent 纯声明元数据服务
   * @param orchestrator LangGraph Agent 编排引擎服务
   * @param trace 链路运行追踪与记录持久化服务
   * @param retriever 知识库检索与向量化服务
   * @param configService 全局配置服务
   */
  constructor(
    private readonly llm: LlmGateway,
    private readonly skills: SkillScannerService,
    private readonly tools: ToolRegistryService,
    private readonly agents: AgentScannerService,
    private readonly orchestrator: LangGraphOrchestratorService,
    private readonly trace: TraceService,
    private readonly retriever: RetrieverService,
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
    @Body() body: AgentRunRequest,
  ): Promise<{ success: true; data: RunResult }> {
    const { agent, input, threadId } = resolveAgentRun(body);
    const result = await this.orchestrator.run(agent, input, undefined, threadId);
    return { success: true, data: result };
  }

  /**
   * 执行指定 Agent 并通过 SSE (Server-Sent Events) 实时推送执行轨迹与增量文本
   *
   * 【SSE 事件流契约】
   * 1. `event: step`：每当产生 plan, tool, observe, final 步骤时实时推送该步骤数据；
   * 2. `event: delta`：模型产出最终答案时按字符流式推送内容片段；
   * 3. `event: done`：流程完全闭合，推送与非流式端点同构的 `{ success: true, data: RunResult }` 载荷（含 threadId）。
   *
   * @param body 请求体
   * @param response Express 原始响应对象
   */
  @Post('agent/run/stream')
  async runAgentStream(
    @Body() body: AgentRunRequest,
    @Res() response: Response,
  ): Promise<void> {
    const { agent, input, threadId } = resolveAgentRun(body);
    this.initSseResponse(response);

    const result = await this.orchestrator.run(agent, input, (event: RuntimeEvent) => {
      if (event.type === 'delta') {
        this.sendSseEvent(response, 'delta', { content: event.content });
        return;
      }
      this.sendSseEvent(response, 'step', event.step);
    }, threadId);

    // 推送结束事件并切断流
    this.sendSseEvent(response, 'done', { success: true, data: result });
    response.end();
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
  async getTrace(@Param('runId') runId: string) {
    const run = await this.findTraceOrThrow(runId);
    return { success: true, data: run };
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
  }> {
    return this.tools.list().map(({ name, description, inputSchema, source }) => ({
      name,
      description,
      inputSchema,
      ...(source ? { source } : {}),
    }));
  }

  /**
   * 获取当前已发现并注册的 Agent 纯声明列表
   *
   * @returns Agent 声明数组
   */
  @Get('agent/list')
  listAgents() {
    return this.agents.list();
  }

  /**
   * 直接单点调用指定的业务技能 (Skill)
   * 用于开发自测或外部系统直接消费业务能力
   *
   * @param name 技能名称
   * @param input 业务输入参数
   * @returns 技能执行返回值
   * @throws 若未注册该名称的技能，返回业务错误码 40401
   */
  @Post('skill/:name/invoke')
  async invokeSkill(
    @Param('name') name: string,
    @Body() input: unknown,
  ): Promise<unknown> {
    const skill = this.findSkillOrThrow(name);
    return skill.execute(input, {});
  }

  /**
   * 大模型直接单次对话（非流式）
   *
   * @param body 对话请求参数
   * @returns `{ output: string }`
   */
  @Post('chat')
  async chat(@Body() body: ChatRequest): Promise<{ output: string }> {
    const result = this.llm.chat(resolveMessages(body), {
      model: body.model,
      tools: body.tools,
      stream: false,
    });
    if (isAsyncIterable(result)) {
      throw new Error('LLM provider returned a stream for a non-streaming request');
    }
    return result;
  }

  /**
   * 大模型流式对话（SSE 协议）
   * 逐片向客户端输出 delta 字符，最后以 `{ output: string }` 的 done 事件结束
   *
   * @param body 对话请求参数
   * @param response Express 响应对象
   */
  @Post('chat/stream')
  async chatStream(
    @Body() body: ChatRequest,
    @Res() response: Response,
  ): Promise<void> {
    this.initSseResponse(response);

    const result = this.llm.chat(resolveMessages(body), {
      model: body.model,
      tools: body.tools,
      stream: true,
    });
    if (!isAsyncIterable(result)) {
      throw new Error('LLM provider did not return a stream for a streaming request');
    }

    let output = '';
    for await (const content of result) {
      output += content;
      this.sendSseEvent(response, 'delta', { content });
    }
    this.sendSseEvent(response, 'done', { output });
    response.end();
  }

  /**
   * 知识库文档分块与向量化灌库端点
   *
   * @param body 可选指定文档目录 path
   * @returns 灌库统计 { ingested: number, chunks: number }
   */
  @Post('rag/ingest')
  async ingestRag(
    @Body() body?: { path?: string },
  ): Promise<{ ingested: number; chunks: number }> {
    const targetDir = this.resolveIngestDirectory(body?.path);
    return this.retriever.ingestFromDirectory(targetDir);
  }

  /**
   * 初始化标准 SSE (Server-Sent Events) HTTP 响应头
   *
   * @param response Express 响应实例
   */
  private initSseResponse(response: Response): void {
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders();
  }

  /**
   * 统一向客户端输出指定事件名称与 JSON 序列化数据的 SSE 帧
   *
   * @param response Express 响应实例
   * @param event 事件名称（如 delta, step, done）
   * @param data 载荷数据
   */
  private sendSseEvent(response: Response, event: string, data: unknown): void {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /**
   * 查找指定的 Trace 运行记录，不存在时抛出业务 40402 异常
   *
   * @param runId 运行标识
   * @returns Trace 记录
   */
  private async findTraceOrThrow(runId: string) {
    const run = await this.trace.load(runId);
    if (!run) {
      throw new HttpException({
        success: false,
        message: `Trace "${runId}" does not exist`,
        code: 40402,
      }, HttpStatus.OK);
    }
    return run;
  }

  /**
   * 查找指定的业务技能，不存在时抛出业务 40401 异常
   *
   * @param name 技能名称
   * @returns 技能定义实例
   */
  private findSkillOrThrow(name: string) {
    const skill = this.skills.get(name);
    if (!skill) {
      throw new HttpException({
        success: false,
        message: `Skill "${name}" is not registered`,
        code: 40401,
      }, HttpStatus.OK);
    }
    return skill;
  }

  /**
   * 解析 RAG 灌库目录物理路径
   *
   * @param customPath 客户端自定义传入的相对/绝对路径
   * @returns 最终绝对路径
   */
  private resolveIngestDirectory(customPath?: string): string {
    return typeof customPath === 'string' && customPath.trim()
      ? resolve(process.cwd(), customPath.trim())
      : resolveRagFixturesPath(this.configService);
  }
}
