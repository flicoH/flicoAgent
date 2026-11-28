import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Optional,
  Param,
  Patch,
  Post,
  Query,
  Req,
  RequestTimeoutException,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConfigService } from '../config/config.service';
import { isAgentLoopMode } from './agent/agent.interface';
import { AgentScannerService } from './agent/agent-scanner.service';
import {
  AgentConfigResponse,
  AgentRunAccess,
  LlmChatResult,
  LlmMessage,
  RunResult,
  RuntimeEvent,
} from './contracts';
import { resolveGuardrailRuleSet } from './guardrail/internal/load-guardrail-config';
import { CheckpointService } from './memory/checkpoint.service';
import {
  resolveMemoryMaxContextTokens,
  resolveMemoryMaxTurns,
  resolveMemorySummarizationOptions,
  resolveThreadEnabled,
} from './memory/internal/load-memory-config';
import {
  computeScopedCheckpointId,
  isScopedCheckpointKey,
} from './memory/internal/token-budget';
import { ThreadService } from './memory/thread.service';
import { resolveRagOptions } from './rag/internal/load-rag-config';
import {
  readLlmConfig,
  resolveCircuitBreakerConfig,
  resolveLlm,
  resolveLlmCandidates,
} from './runtime/internal/load-llm-config';
import { resolveMaxIterations, resolveToolConcurrency } from './runtime/internal/load-runtime-config';
import {
  LangChainPlannerService,
  toLangChainMessages,
} from './runtime/langchain/langchain-planner.service';
import {
  LangGraphOrchestratorService,
  toPublicRunDetail,
} from './runtime/langgraph/langgraph-orchestrator.service';
import { SkillScannerService } from './skill/skill-scanner.service';
import {
  CapabilityApprovalRequired,
  CapabilityInputInvalid,
  CapabilityTimeoutError,
  ExecutorService,
} from './tool/executor.service';
import {
  resolveHttpToolOptions,
  resolveSqlToolOptions,
  resolveToolGuardOptions,
} from './tool/internal/load-tools-config';
import { ToolRegistryService } from './tool/tool-registry.service';
import { TraceService } from './trace/trace.service';

const ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SSE_HEARTBEAT_MS = 15_000;

interface AgentRunRequest {
  agent?: unknown;
  input?: unknown;
  threadId?: unknown;
}

interface ChatRequest {
  message?: unknown;
  messages?: unknown;
  model?: unknown;
  tools?: unknown;
}

interface ApprovalDecisionRequest {
  approvalId?: unknown;
  approved?: unknown;
}

function resolveAgentRun(body: AgentRunRequest): { agent: string; input: unknown; threadId?: string } {
  if (!body || typeof body !== 'object' || typeof body.agent !== 'string' || !body.agent.trim() || body.agent.trim().length > 128) {
    throw new BadRequestException('agent is required');
  }
  if (body.input === undefined) {
    throw new BadRequestException('input is required');
  }
  let threadId: string | undefined;
  if (body.threadId !== undefined) {
    if (typeof body.threadId !== 'string' || !ID_PATTERN.test(body.threadId.trim())) {
      throw new BadRequestException('Invalid threadId');
    }
    threadId = body.threadId.trim();
  }
  return { agent: body.agent.trim(), input: body.input, ...(threadId ? { threadId } : {}) };
}

function resolveChatMessages(body: ChatRequest): { messages: LlmMessage[]; model?: string; tools?: unknown[] } {
  if (!body || typeof body !== 'object') {
    throw new BadRequestException('Invalid chat request');
  }
  let model: string | undefined;
  if (body.model !== undefined) {
    if (typeof body.model !== 'string' || !body.model.trim() || body.model.length > 128) {
      throw new BadRequestException('Invalid model');
    }
    model = body.model.trim();
  }
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    throw new BadRequestException('Invalid tools');
  }
  if (Array.isArray(body.messages)) {
    if (body.messages.length === 0) {
      throw new BadRequestException('messages cannot be empty');
    }
    for (const msg of body.messages) {
      if (!msg || typeof msg !== 'object') {
        throw new BadRequestException('Invalid chat message');
      }
      const role = (msg as { role?: unknown }).role;
      const content = (msg as { content?: unknown }).content;
      if (role === 'user' || role === 'system') {
        if (typeof content !== 'string') throw new BadRequestException('Invalid message content');
      } else if (role === 'assistant') {
        if (content !== null && typeof content !== 'string') throw new BadRequestException('Invalid assistant message');
      } else if (role === 'tool') {
        if (typeof content !== 'string' || typeof (msg as { tool_call_id?: unknown }).tool_call_id !== 'string') {
          throw new BadRequestException('Invalid tool message');
        }
      } else {
        throw new BadRequestException('Invalid message role');
      }
    }
    return { messages: body.messages as LlmMessage[], model, tools: body.tools as unknown[] | undefined };
  }
  if (typeof body.message === 'string' && body.message.trim()) {
    return { messages: [{ role: 'user', content: body.message }], model, tools: body.tools as unknown[] | undefined };
  }
  throw new BadRequestException('message or messages is required');
}

function parseNonNegativeInt(raw: unknown, fallback: number, max: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const text = Array.isArray(raw) ? undefined : String(raw);
  if (!text || !/^\d+$/.test(text)) {
    throw new BadRequestException(`Invalid ${name}`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new BadRequestException(`Invalid ${name}`);
  }
  return value;
}

@Controller('api/ai')
export class AiController {
  constructor(
    private readonly tools: ToolRegistryService,
    private readonly agents: AgentScannerService,
    private readonly orchestrator: LangGraphOrchestratorService,
    private readonly trace: TraceService,
    private readonly configService: ConfigService,
    @Optional() private readonly skills?: SkillScannerService,
    @Optional() private readonly executor?: ExecutorService,
    @Optional() private readonly planner?: LangChainPlannerService,
    @Optional() private readonly threadService?: ThreadService,
    @Optional() private readonly checkpointService?: CheckpointService,
  ) {}

  @Post('chat')
  async chat(@Body() body: ChatRequest): Promise<LlmChatResult> {
    const { messages, model, tools } = resolveChatMessages(body);
    if (this.planner) {
      return this.planner.chat(messages, { model, tools });
    }
    const resolved = resolveLlm(this.configService, model);
    if (resolved.kind === 'custom') {
      const result = await resolved.provider.chat(messages, { model, tools });
      if (Symbol.asyncIterator in result) {
        let output = '';
        for await (const chunk of result) output += chunk;
        return { output };
      }
      return result;
    }

    const lcMessages = toLangChainMessages(messages);
    const aiMessage = await resolved.model.invoke(lcMessages);
    const output = typeof aiMessage.content === 'string' ? aiMessage.content : JSON.stringify(aiMessage.content ?? '');
    const metadata = aiMessage.usage_metadata;
    const usage = metadata ? {
      inputTokens: metadata.input_tokens,
      outputTokens: metadata.output_tokens,
      totalTokens: metadata.total_tokens,
    } : undefined;
    return {
      output,
      message: { role: 'assistant', content: output },
      ...(usage ? { usage } : {}),
    };
  }

  @Post('chat/stream')
  async chatStream(@Body() body: ChatRequest, @Res() response: Response): Promise<void> {
    const { messages, model, tools } = resolveChatMessages(body);
    if (this.planner) {
      resolveLlmCandidates(this.configService, model);
      this.initSseResponse(response);
      const heartbeat = this.startHeartbeat(response);
      try {
        const result = await this.planner.chatStream(messages, {
          model,
          tools,
          onDelta: (content) => {
            this.sendSseEvent(response, 'delta', { content });
          },
          resetDelta: () => {
            this.sendSseEvent(response, 'delta_reset', {});
          },
        });
        this.sendSseEvent(response, 'done', result);
      } catch {
        this.sendSseEvent(response, 'error', { success: false, message: 'Chat stream failed', code: 500 });
      } finally {
        clearInterval(heartbeat);
        response.end();
      }
      return;
    }

    const resolved = resolveLlm(this.configService, model);
    this.initSseResponse(response);
    const heartbeat = this.startHeartbeat(response);
    try {
      let output = '';
      if (resolved.kind === 'custom') {
        const result = await resolved.provider.chat(messages, { model, tools, stream: true });
        if (Symbol.asyncIterator in result) {
          for await (const chunk of result) {
            output += chunk;
            this.sendSseEvent(response, 'delta', { content: chunk });
          }
          this.sendSseEvent(response, 'done', { output });
        } else {
          output = result.output;
          if (output) this.sendSseEvent(response, 'delta', { content: output });
          this.sendSseEvent(response, 'done', result);
        }
      } else {
        const stream = await resolved.model.stream(toLangChainMessages(messages));
        for await (const chunk of stream) {
          const text = typeof chunk.content === 'string' ? chunk.content : '';
          if (text) {
            output += text;
            this.sendSseEvent(response, 'delta', { content: text });
          }
        }
        this.sendSseEvent(response, 'done', { output });
      }
    } catch {
      this.sendSseEvent(response, 'error', { success: false, message: 'Chat stream failed', code: 500 });
    } finally {
      clearInterval(heartbeat);
      response.end();
    }
  }

  @Post('agent/run')
  async runAgent(
    @Body() body: AgentRunRequest,
    @Req() request?: Request,
  ): Promise<{ success: true; data: RunResult }> {
    const { agent, input, threadId } = resolveAgentRun(body);
    const result = await this.orchestrator.run(agent, input, undefined, threadId, request?.agentRunAccess);
    return { success: true, data: result };
  }

  @Post('agent/run/stream')
  async runAgentStream(
    @Body() body: AgentRunRequest,
    @Res() response: Response,
    @Req() request?: Request,
  ): Promise<void> {
    const { agent, input, threadId } = resolveAgentRun(body);
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      const result = await this.orchestrator.run(agent, input, (event: RuntimeEvent) => {
        if (!response.headersSent) {
          this.initSseResponse(response);
          heartbeat = this.startHeartbeat(response);
        }
        if (event.type === 'start') {
          this.sendSseEvent(response, 'start', { runId: event.runId });
          return;
        }
        if (event.type === 'delta') {
          this.sendSseEvent(response, 'delta', { content: event.content });
          return;
        }
        if (event.type === 'delta_reset') {
          this.sendSseEvent(response, 'delta_reset', {});
          return;
        }
        if (event.type === 'status') {
          this.sendSseEvent(response, 'status', {
            status: event.status,
            ...(event.approval ? { approval: event.approval } : {}),
            ...(event.failure ? { failure: event.failure } : {}),
          });
          return;
        }
        this.sendSseEvent(response, 'step', event.step);
      }, threadId, request?.agentRunAccess);

      if (!response.headersSent) {
        this.initSseResponse(response);
      }
      this.sendSseEvent(response, 'done', { success: true, data: result });
      response.end();
    } catch (error) {
      if (!response.headersSent) {
        throw error;
      }
      this.sendSseEvent(response, 'error', {
        success: false,
        message: 'Agent stream failed',
        code: 500,
      });
      response.end();
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  @Post('agent/runs')
  @HttpCode(HttpStatus.ACCEPTED)
  async submitAgentRun(
    @Body() body: AgentRunRequest,
    @Req() request?: Request,
  ) {
    const { agent, input, threadId } = resolveAgentRun(body);
    const data = await this.orchestrator.submit(agent, input, threadId, request?.agentRunAccess);
    return { success: true as const, data };
  }

  @Get('agent/runs')
  async listAgentRuns(
    @Query('limit') rawLimit?: unknown,
    @Query('offset') rawOffset?: unknown,
    @Req() request?: Request,
  ) {
    const limit = parseNonNegativeInt(rawLimit, 20, 100, 'limit');
    if (limit < 1) {
      throw new BadRequestException('Invalid limit');
    }
    const offset = parseNonNegativeInt(rawOffset, 0, 100_000, 'offset');
    const access = request?.agentRunAccess;
    const runs = await this.orchestrator.list({
      scope: access?.scope,
      agents: access?.agents,
      offset,
      limit,
    });
    return {
      success: true as const,
      data: {
        limit,
        offset,
        items: runs.map(run => ({
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
        })),
      },
    };
  }

  @Get('agent/runs/:runId')
  async getAgentRun(@Param('runId') runId: string, @Req() request?: Request) {
    const run = await this.orchestrator.find(runId, request?.agentRunAccess);
    if (!run) {
      throw new NotFoundException(`Run "${runId}" does not exist`);
    }
    return { success: true as const, data: toPublicRunDetail(run) };
  }

  @Get('agent/runs/:runId/events')
  async subscribeAgentRunEvents(
    @Param('runId') runId: string,
    @Query('after') rawAfter: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const after = parseNonNegativeInt(rawAfter, 0, 1_000_000, 'after');
    let heartbeat: NodeJS.Timeout | undefined;
    let unsubscribe: (() => void) | undefined;

    await new Promise<void>(async (resolve, reject) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        if (!response.writableEnded) response.end();
        resolve();
      };

      try {
        unsubscribe = await this.orchestrator.subscribe(runId, after, request.agentRunAccess, (evt) => {
          if (!response.headersSent) {
            this.initSseResponse(response);
            heartbeat = this.startHeartbeat(response);
          }
          this.sendSseEvent(response, evt.event, evt.data);
          if (evt.event === 'done') {
            finish();
          }
        });
        if (!finished) {
          request.on('close', finish);
        }
      } catch (error) {
        if (heartbeat) clearInterval(heartbeat);
        reject(error);
      }
    });
  }

  @Post('agent/runs/:runId/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelAgentRun(@Param('runId') runId: string, @Req() request?: Request) {
    const data = await this.orchestrator.cancel(runId, request?.agentRunAccess);
    return { success: true as const, data };
  }

  @Post('agent/runs/:runId/approval')
  @HttpCode(HttpStatus.ACCEPTED)
  async approveAgentRun(
    @Param('runId') runId: string,
    @Body() body: ApprovalDecisionRequest,
    @Req() request?: Request,
  ) {
    if (!body || typeof body !== 'object' || typeof body.approvalId !== 'string' || !UUID_PATTERN.test(body.approvalId) || typeof body.approved !== 'boolean') {
      throw new BadRequestException('approvalId (uuid) and approved (boolean) are required');
    }
    const data = await this.orchestrator.decide(runId, body.approvalId, body.approved, request?.agentRunAccess);
    return { success: true as const, data };
  }

  @Post('skill/:name/invoke')
  async invokeSkill(
    @Param('name') name: string,
    @Body() body: unknown,
    @Req() request?: Request,
  ) {
    const access = request?.agentRunAccess;
    if (access?.skills && !access.skills.includes(name)) {
      throw new ForbiddenException(`Skill "${name}" cannot be invoked directly by this caller`);
    }
    const skill = this.skills?.get(name);
    if (!skill) {
      throw new NotFoundException(`Skill "${name}" is not registered`);
    }
    if (!this.executor) {
      throw new NotFoundException('Skill executor is unavailable');
    }
    try {
      const output = await this.executor.invokeSkill(skill, body, {
        scope: access?.scope,
        directInvoke: true,
      });
      return { success: true as const, data: output };
    } catch (error) {
      if (error instanceof CapabilityApprovalRequired) {
        throw new ForbiddenException(error.message);
      }
      if (error instanceof CapabilityInputInvalid) {
        throw new BadRequestException(error.message);
      }
      if (error instanceof CapabilityTimeoutError) {
        throw new RequestTimeoutException(error.message);
      }
      throw error;
    }
  }

  @Get('threads')
  async listThreads(
    @Query('limit') rawLimit?: unknown,
    @Query('offset') rawOffset?: unknown,
    @Req() request?: Request,
  ) {
    if (!this.checkpointService || !this.threadService) {
      throw new NotFoundException('Thread memory service is unavailable');
    }
    const limit = parseNonNegativeInt(rawLimit, 20, 100, 'limit');
    if (limit < 1) {
      throw new BadRequestException('Invalid limit');
    }
    const offset = parseNonNegativeInt(rawOffset, 0, 100_000, 'offset');
    const access = request?.agentRunAccess;
    const checkpoints = await this.checkpointService.list({
      scope: access?.scope,
      offset,
      limit,
    });
    return {
      success: true as const,
      data: {
        limit,
        offset,
        items: checkpoints.map(cp => this.threadService!.toThreadSummary(cp)),
      },
    };
  }

  @Get('threads/:threadId')
  async getThread(
    @Param('threadId') threadId: string,
    @Req() request?: Request,
  ) {
    if (!this.checkpointService || !this.threadService) {
      throw new NotFoundException('Thread memory service is unavailable');
    }
    const { checkpointId } = this.resolveThreadKey(threadId, request?.agentRunAccess);
    const checkpoint = await this.checkpointService.load(checkpointId);
    if (!checkpoint || checkpoint.scope !== request?.agentRunAccess?.scope) {
      throw new NotFoundException(`Thread "${threadId}" does not exist`);
    }
    return {
      success: true as const,
      data: this.threadService.toThreadDetail(checkpoint),
    };
  }

  @Patch('threads/:threadId')
  async updateThread(
    @Param('threadId') threadId: string,
    @Body() body: { title?: unknown },
    @Req() request?: Request,
  ) {
    if (!this.checkpointService || !this.threadService) {
      throw new NotFoundException('Thread memory service is unavailable');
    }
    if (!body || typeof body !== 'object' || typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 200) {
      throw new BadRequestException('title must be a non-empty string up to 200 characters');
    }
    const nextTitle = body.title.trim();
    const access = request?.agentRunAccess;
    const { checkpointId } = this.resolveThreadKey(threadId, access);

    const updated = await this.checkpointService.runTurn(checkpointId, async () => {
      const checkpoint = await this.checkpointService!.load(checkpointId);
      if (!checkpoint || checkpoint.scope !== access?.scope) {
        throw new NotFoundException(`Thread "${threadId}" does not exist`);
      }
      const next = {
        ...checkpoint,
        title: nextTitle,
        updatedAt: Math.max(Date.now(), (checkpoint.updatedAt || 0) + 1),
      };
      await this.checkpointService!.save(next);
      return next;
    });

    return {
      success: true as const,
      data: this.threadService.toThreadSummary(updated),
    };
  }

  @Post('threads/:threadId/clear')
  @HttpCode(HttpStatus.OK)
  async clearThread(
    @Param('threadId') threadId: string,
    @Req() request?: Request,
  ) {
    if (!this.checkpointService || !this.threadService) {
      throw new NotFoundException('Thread memory service is unavailable');
    }
    const access = request?.agentRunAccess;
    const { checkpointId } = this.resolveThreadKey(threadId, access);

    const cleared = await this.checkpointService.runTurn(checkpointId, async () => {
      const checkpoint = await this.checkpointService!.load(checkpointId);
      if (!checkpoint || checkpoint.scope !== access?.scope) {
        throw new NotFoundException(`Thread "${threadId}" does not exist`);
      }
      const next = {
        ...checkpoint,
        messages: [],
        summary: undefined,
        summarizedCount: 0,
        updatedAt: Math.max(Date.now(), (checkpoint.updatedAt || 0) + 1),
      };
      await this.checkpointService!.save(next);
      return next;
    });

    return {
      success: true as const,
      data: this.threadService.toThreadSummary(cleared),
    };
  }

  @Delete('threads/:threadId')
  async deleteThread(
    @Param('threadId') threadId: string,
    @Req() request?: Request,
  ) {
    if (!this.checkpointService || !this.threadService) {
      throw new NotFoundException('Thread memory service is unavailable');
    }
    const access = request?.agentRunAccess;
    const { publicThreadId, checkpointId } = this.resolveThreadKey(threadId, access);

    await this.checkpointService.runTurn(checkpointId, async () => {
      const checkpoint = await this.checkpointService!.load(checkpointId);
      if (!checkpoint || checkpoint.scope !== access?.scope) {
        throw new NotFoundException(`Thread "${threadId}" does not exist`);
      }
      await this.checkpointService!.delete(checkpointId);
    });

    return {
      success: true as const,
      data: {
        threadId: publicThreadId,
        deleted: true,
      },
    };
  }

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

  @Get('trace/:runId')
  async getTrace(@Param('runId') runId: string, @Req() request?: Request) {
    const run = await this.findTraceOrThrow(runId, request?.agentRunAccess);
    return { success: true, data: run };
  }

  @Get('trace/:runId/usage')
  async getTraceUsage(@Param('runId') runId: string, @Req() request?: Request) {
    const run = await this.findTraceOrThrow(runId, request?.agentRunAccess);
    return {
      success: true,
      data: { runId: run.runId, usage: run.usage ?? null },
    };
  }

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

    const llmConfig = readLlmConfig(this.configService);
    const llmFallbacks = Array.isArray(llmConfig?.fallbacks)
      ? llmConfig.fallbacks.filter((name): name is string => typeof name === 'string' && Boolean(name.trim())).map(name => name.trim())
      : [];
    const llmCircuitBreaker = llmConfig?.circuitBreaker !== undefined
      ? resolveCircuitBreakerConfig(this.configService, llmFallbacks.length > 0)
      : undefined;

    const toolGuard = resolveToolGuardOptions(this.configService);
    const httpTool = resolveHttpToolOptions(this.configService);
    const sqlTool = resolveSqlToolOptions(this.configService);
    const memoryMaxContextTokens = resolveMemoryMaxContextTokens(this.configService);
    const memorySummarization = resolveMemorySummarizationOptions(this.configService);

    return {
      threadEnabled: resolveThreadEnabled(this.configService),
      maxIterations: resolveMaxIterations(this.configService),
      toolConcurrency: resolveToolConcurrency(this.configService),
      memory: {
        maxTurns: resolveMemoryMaxTurns(this.configService),
        ...(memoryMaxContextTokens !== undefined ? { maxContextTokens: memoryMaxContextTokens } : {}),
        ...(memorySummarization.enabled ? {
          summarization: {
            enabled: true,
            ...(memorySummarization.model ? { model: memorySummarization.model } : {}),
            triggerTokens: memorySummarization.triggerTokens,
            keepRecentMessages: memorySummarization.keepRecentMessages,
            maxSummaryChars: memorySummarization.maxSummaryChars,
          },
        } : {}),
      },
      tools: {
        timeoutMs: toolGuard.timeoutMs,
        maxOutputChars: toolGuard.maxOutputChars,
        http: {
          enabled: httpTool.enabled,
          allowedHosts: httpTool.allowedHosts,
          allowedMethods: httpTool.allowedMethods,
          allowPrivateNetworks: httpTool.allowPrivateNetworks,
          timeoutMs: httpTool.timeoutMs,
          maxResponseBytes: httpTool.maxResponseBytes,
        },
        sql: {
          enabled: sqlTool.enabled,
          maxRows: sqlTool.maxRows,
          timeoutMs: sqlTool.timeoutMs,
          ...(sqlTool.allowedTables.length ? { allowedTables: sqlTool.allowedTables } : {}),
        },
      },
      llm: {
        default: defaultLlm,
        models: modelNames(llm?.models),
        ...(llmFallbacks.length ? { fallbacks: llmFallbacks } : {}),
        ...(llmCircuitBreaker ? { circuitBreaker: llmCircuitBreaker } : {}),
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

  private initSseResponse(response: Response): void {
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders();
  }

  private startHeartbeat(response: Response): NodeJS.Timeout {
    const timer = setInterval(() => {
      if (!response.writableEnded) {
        response.write(': heartbeat\n\n');
      }
    }, SSE_HEARTBEAT_MS);
    timer.unref();
    return timer;
  }

  private sendSseEvent(response: Response, event: string, data: unknown): void {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private resolveThreadKey(
    threadId: string,
    access?: AgentRunAccess,
  ): { publicThreadId: string; checkpointId: string } {
    if (typeof threadId !== 'string' || !ID_PATTERN.test(threadId.trim())) {
      throw new BadRequestException('Invalid threadId');
    }
    const publicThreadId = threadId.trim();
    if (access?.scope === undefined && isScopedCheckpointKey(publicThreadId)) {
      throw new BadRequestException('Invalid threadId');
    }
    return {
      publicThreadId,
      checkpointId: computeScopedCheckpointId(access?.scope, publicThreadId),
    };
  }

  private async findTraceOrThrow(runId: string, access?: AgentRunAccess) {
    if (access && (runId === 'latest' || runId === 'runId' || !ID_PATTERN.test(runId))) {
      throw new HttpException({
        success: false,
        message: `Trace "${runId}" does not exist`,
        code: 40402,
      }, HttpStatus.OK);
    }
    const run = await this.trace.load(runId);
    if (!run || run.scope !== access?.scope || (access?.agents && !access.agents.includes(run.agent))) {
      throw new HttpException({
        success: false,
        message: `Trace "${runId}" does not exist`,
        code: 40402,
      }, HttpStatus.OK);
    }
    const { scope: _scope, workerId: _workerId, continuation: _continuation, ...trace } = run;
    return trace;
  }
}
