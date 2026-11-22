import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConfigService } from '../config/config.service';
import { isAgentLoopMode } from './agent/agent.interface';
import { AgentScannerService } from './agent/agent-scanner.service';
import { resolveGuardrailRuleSet } from './guardrail/internal/load-guardrail-config';
import { resolveMemoryMaxTurns, resolveThreadEnabled } from './memory/internal/load-memory-config';
import { resolveRagOptions } from './rag/internal/load-rag-config';
import { resolveMaxIterations } from './runtime/internal/load-runtime-config';
import { LangGraphOrchestratorService } from './runtime/langgraph/langgraph-orchestrator.service';
import { AgentConfigResponse, AgentRunAccess, RunResult, RuntimeEvent } from './contracts';
import { ToolRegistryService } from './tool/tool-registry.service';
import { TraceService } from './trace/trace.service';

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
 * AI 综合控制器 (AiController)
 *
 * 【安全与鉴权机制】
 * 路由挂载于 `/api/ai/*`，由全局 `ApiSignGuard` 校验。配置 `ai.access` 后，
 * Agent 运行和 Trace 路由会根据调用方的签名或会话确定访问范围。
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
 *    - GET `/api/ai/agent/config`：查询脱敏后的 AI 与知识库运行配置
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
    @Body() body: AgentRunRequest,
    @Req() request?: Request,
  ): Promise<{ success: true; data: RunResult }> {
    const { agent, input, threadId } = resolveAgentRun(body);
    const result = await this.orchestrator.run(agent, input, undefined, threadId, request?.agentRunAccess);
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
    @Req() request?: Request,
  ): Promise<void> {
    const { agent, input, threadId } = resolveAgentRun(body);
    const result = await this.orchestrator.run(agent, input, (event: RuntimeEvent) => {
      if (!response.headersSent) {
        this.initSseResponse(response);
      }
      if (event.type === 'delta') {
        this.sendSseEvent(response, 'delta', { content: event.content });
        return;
      }
      this.sendSseEvent(response, 'step', event.step);
    }, threadId, request?.agentRunAccess);
    if (!response.headersSent) {
      this.initSseResponse(response);
    }

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
  getAgentGraph(@Query('mode') mode?: string): { nodes: unknown; edges: unknown } {
    if (mode === undefined) {
      return this.orchestrator.getGraph();
    }
    if (!isAgentLoopMode(mode)) {
      throw new BadRequestException('Invalid Agent loop mode');
    }
    return this.orchestrator.getGraph(mode);
  }

  /**
   * 根据 runId 查询历史运行追踪记录
   *
   * @param runId 运行任务 ID
   * @returns 包含完整 TraceRun 对象的响应
   * @throws 若记录不存在，返回业务错误码 40402
   */
  @Get('trace/:runId')
  async getTrace(@Param('runId') runId: string, @Req() request?: Request) {
    const run = await this.findTraceOrThrow(runId, request?.agentRunAccess);
    return { success: true, data: run };
  }

  /**
   * 按 runId 查询已持久化的 token 用量合计。
   * 已存在的运行没有用量记录时返回 null，找不到运行时沿用 Trace 查询的错误响应。
   */
  @Get('trace/:runId/usage')
  async getTraceUsage(@Param('runId') runId: string, @Req() request?: Request) {
    const run = await this.findTraceOrThrow(runId, request?.agentRunAccess);
    return {
      success: true,
      data: { runId: run.runId, usage: run.usage ?? null },
    };
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

  @Get('agent/config')
  getAgentConfig(): AgentConfigResponse {
    const ai = this.configService.get<Record<string, unknown>>('ai');
    const llm = (ai?.llm ?? this.configService.get('ai.llm')) as { default?: unknown; models?: unknown } | undefined;
    const embedding = (ai?.embedding ?? this.configService.get('ai.embedding')) as {
      default?: unknown; models?: unknown;
    } | undefined;
    const mcp = (ai?.mcp ?? this.configService.get('ai.mcp')) as { enabled?: unknown; servers?: unknown } | undefined;
    const ragOptions = resolveRagOptions(this.configService);
    const ragSource = (ragOptions.source ?? this.configService.get('ai.rag.source')) as {
      driver?: unknown; collection?: unknown;
    } | undefined;
    const vectorConfig = ((ai?.store as Record<string, unknown> | undefined)?.vector
      ?? this.configService.get('ai.store.vector')) as {
      driver?: unknown; namespace?: unknown; dimensions?: unknown;
    } | string | undefined;

    const modelNames = (value: unknown): string[] => (
      value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : []
    );
    const defaultLlm = typeof llm?.default === 'string' && llm.default.trim() ? llm.default.trim() : null;
    const defaultEmbedding = typeof embedding?.default === 'string' && embedding.default.trim()
      ? embedding.default.trim() : null;
    const wikiModel = typeof ragOptions.wiki?.model === 'string' && ragOptions.wiki.model.trim()
      ? ragOptions.wiki.model.trim() : defaultLlm;

    const sourceDriver = ragSource?.driver === 'mysql' ? 'mysql' : 'file';
    const vectorObj = vectorConfig && typeof vectorConfig === 'object' ? vectorConfig : undefined;
    const vectorDriver = vectorObj?.driver === 'mysql' || vectorObj?.driver === 'qdrant' ? vectorObj.driver : 'file';
    const guardrail = resolveGuardrailRuleSet(this.configService);

    return {
      threadEnabled: resolveThreadEnabled(this.configService),
      maxIterations: resolveMaxIterations(this.configService),
      memory: {
        maxTurns: resolveMemoryMaxTurns(this.configService),
      },
      llm: {
        default: defaultLlm,
        models: modelNames(llm?.models),
      },
      embedding: {
        default: defaultEmbedding,
        models: modelNames(embedding?.models),
      },
      rag: {
        mode: ragOptions.mode,
        topK: ragOptions.topK,
        chunk: ragOptions.chunk,
        tool: ragOptions.tool,
        wiki: { model: wikiModel },
        source: {
          driver: sourceDriver,
          ...(sourceDriver === 'mysql'
            ? { collection: typeof ragSource?.collection === 'string' ? ragSource.collection : 'default' }
            : {}),
        },
        vector: {
          driver: vectorDriver,
          ...(vectorDriver !== 'file'
            ? { namespace: typeof vectorObj?.namespace === 'string' ? vectorObj.namespace : 'default' }
            : {}),
          ...(vectorDriver === 'qdrant' && typeof vectorObj?.dimensions === 'number'
            ? { dimensions: vectorObj.dimensions } : {}),
        },
      },
      mcp: {
        enabled: Boolean(mcp?.enabled),
        servers: Array.isArray(mcp?.servers)
          ? mcp.servers
            .map(server => (server && typeof server === 'object' && typeof (server as { name?: unknown }).name === 'string'
              ? (server as { name: string }).name.trim() : ''))
            .filter(Boolean)
          : [],
      },
      guardrail: {
        enabled: Boolean(guardrail.blockedKeywords?.length || guardrail.blockedPatterns?.length),
      },
    };
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
  private async findTraceOrThrow(runId: string, access?: AgentRunAccess) {
    const run = await this.trace.load(runId);
    if (!run || run.scope !== access?.scope || (access?.agents && !access.agents.includes(run.agent))) {
      throw new HttpException({
        success: false,
        message: `Trace "${runId}" does not exist`,
        code: 40402,
      }, HttpStatus.OK);
    }
    const { scope, ...trace } = run;
    return trace;
  }
}
