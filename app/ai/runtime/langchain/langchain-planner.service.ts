import { Injectable, Optional } from '@nestjs/common';
import type { ChatOpenAI } from '@langchain/openai';
import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type { StructuredTool } from '@langchain/core/tools';
import type { LlmGenerationOptions } from '../../../config/bootstrap-options';
import { ConfigService } from '../../../config/config.service';
import type {
  LlmAssistantMessage,
  LlmChatResult,
  LlmFallbackEvent,
  LlmMessage,
  LlmProvider,
  TokenUsage,
} from '../../contracts';
import {
  classifyLlmError,
  LlmCircuitBreakerService,
  LlmCircuitOpenError,
} from '../internal/llm-circuit-breaker';
import {
  resolveCircuitBreakerConfig,
  resolveLlm,
  resolveLlmCandidates,
  type ResolvedLlm,
} from '../internal/load-llm-config';

/**
 * LangChain 规划器解析出的单个工具调用项
 */
export interface LangChainToolCall {
  /** 工具调用的唯一标识 ID */
  id: string;
  /** 调用的目标工具名称 */
  name: string;
  /** 结构化参数对象 */
  args: Record<string, unknown> | unknown;
}

/**
 * LangChain 规划器单轮决策结果
 * 严格互斥产出：toolCalls（调用工具）或 finalAnswer（最终答案）
 */
export interface LangChainPlanResult {
  usage?: TokenUsage;
  /** 若模型判定需要执行能力，返回待调用的工具指令列表 */
  toolCalls?: LangChainToolCall[];
  /** 若模型认为信息足够回答，返回最终文本结论 */
  finalAnswer?: string;
  /** 模型原装助手机器人回复实体（原样回填对话上下文） */
  response?: LlmAssistantMessage;
  /** 实际执行成功的模型注册名 */
  model?: string;
  /** 本次规划期间发生的模型切换事件（无切换时缺省） */
  fallbacks?: LlmFallbackEvent[];
  /** 明确标识由 LangChain 规划器驱动 */
  planner: 'langchain';
}

export interface LangChainPlanOptions extends LlmGenerationOptions {
  model?: string;
  fallbacks?: string[];
  signal?: AbortSignal;
  onDelta?: (content: string) => void | Promise<void>;
  resetDelta?: () => void | Promise<void>;
  onFallback?: (event: LlmFallbackEvent) => void | Promise<void>;
}

export interface ResilientChatOptions extends LlmGenerationOptions {
  model?: string;
  fallbacks?: string[];
  tools?: unknown[];
  signal?: AbortSignal;
  onFallback?: (event: LlmFallbackEvent) => void | Promise<void>;
}

export interface ResilientChatStreamOptions extends ResilientChatOptions {
  onDelta?: (content: string) => void | Promise<void>;
  resetDelta?: () => void | Promise<void>;
}

/**
 * 执行单轮决策规划
 *
 * @param messages 当前完整的多轮消息历史
 * @param tools 开放调用的 StructuredTool 列表
 * @param options 可选配置（模型覆盖、推理参数、备模型、AbortSignal、流式 delta 与 fallback 回调）
 * @returns LangChainPlanResult（包含 toolCalls 或 finalAnswer，以及 planner='langchain'）
 */
export interface LangChainPlanResultWithStream extends LangChainPlanResult {
  streamed?: boolean;
}

interface JsonPlan {
  /** 动作标识：'call' | 'invoke' | 'tool' | 'skill' | 'final' */
  action?: string;
  /** 调用的能力名称 */
  name?: string;
  /** 调用参数 */
  input?: unknown;
  /** 最终回答文本 */
  response?: string;
}

interface ResilienceRunOptions extends LlmGenerationOptions {
  model?: string;
  fallbacks?: string[];
  signal?: AbortSignal;
  resetDelta?: () => void | Promise<void>;
  onFallback?: (event: LlmFallbackEvent) => void | Promise<void>;
}

interface AttemptCallbacks {
  markDeltaEmitted: () => void;
  markDeltaReset: () => void;
}

/**
 * 从普通文本中安全解析提取 JSON
 * 支持直接 JSON 字符串、markdown 代码块包围的 JSON、以及混排在文本中的最外层花括号结构
 *
 * @param text 输入的原始文本
 * @returns 解析得到的泛型对象，解析失败返回 null
 */
function extractJson<T = unknown>(text: string): T | null {
  if (!text || typeof text !== 'string') {
    return null;
  }
  const trimmed = text.trim();

  // 1. 尝试直接完整解析
  try {
    return JSON.parse(trimmed) as T;
  } catch {}

  // 2. 匹配 ```json ... ``` 块
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch?.[1]) {
    try {
      return JSON.parse(codeBlockMatch[1].trim()) as T;
    } catch {}
  }

  // 3. 匹配最外层的 {...} 对象结构
  const startIdx = trimmed.indexOf('{');
  const endIdx = trimmed.lastIndexOf('}');
  if (startIdx !== -1 && endIdx > startIdx) {
    try {
      return JSON.parse(trimmed.slice(startIdx, endIdx + 1)) as T;
    } catch {}
  }

  return null;
}

/**
 * 将框架通用的 LlmMessage 消息转换为 LangChain BaseMessage 实例
 *
 * 【角色对齐映射】
 * - `system`    -> `SystemMessage`
 * - `user`      -> `HumanMessage`
 * - `assistant` -> `AIMessage`（自动转换 tool_calls）
 * - `tool`      -> `ToolMessage`（挂载 tool_call_id）
 *
 * @param messages 框架原始消息或已有的 BaseMessage 数组
 * @returns LangChain BaseMessage 数组
 */
export function toLangChainMessages(messages: (LlmMessage | BaseMessage)[]): BaseMessage[] {
  return messages.map((msg) => {
    if (msg instanceof BaseMessage) {
      return msg;
    }

    switch (msg.role) {
      case 'system':
        return new SystemMessage(msg.content);
      case 'user':
        return new HumanMessage(msg.content);
      case 'assistant': {
        const toolCalls = msg.tool_calls?.map((tc) => ({
          name: tc.function.name,
          args: typeof tc.function.arguments === 'string'
            ? (() => {
                try {
                  return JSON.parse(tc.function.arguments);
                } catch {
                  return extractJson(tc.function.arguments) ?? {};
                }
              })()
            : tc.function.arguments ?? {},
          id: tc.id,
          type: 'tool_call' as const,
        }));
        return new AIMessage({
          content: msg.content ?? '',
          tool_calls: toolCalls,
        });
      }
      case 'tool':
        return new ToolMessage({
          content: msg.content,
          tool_call_id: msg.tool_call_id,
        });
      default:
        return new HumanMessage(String((msg as unknown as { content?: unknown }).content ?? ''));
    }
  });
}

function createAbortError(message: string): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

/**
 * 基于 LangChain 的规划器服务 (LangChainPlannerService)
 *
 * 【职责与定位】
 * 在 LangGraph 编排循环中担任核心推理大脑：
 * 1. 采用 LangChain ChatOpenAI + `bindTools` 机制将白名单内的工具注入大模型调用上下文；
 * 2. 规划决策单轮原子输出：要么产出 `toolCalls`，要么给出 `finalAnswer`；
 * 3. 支持推理参数配置、主备模型链式 Fallback、单次调用超时守卫与三态熔断保护；
 * 4. 在规划步骤中明确注入 `planner: 'langchain'` 标识；
 * 5. 通过 use 配置的 Provider 直接使用框架对话协议。
 */
@Injectable()
export class LangChainPlannerService {
  private readonly circuitBreaker: LlmCircuitBreakerService;

  /**
   * 构造函数注入全局配置服务与可选熔断器服务
   *
   * @param config 全局统一配置服务
   * @param circuitBreaker 可选模型熔断器服务（单测独立实例化时缺省自动创建本地实例）
   */
  constructor(
    private readonly config: ConfigService,
    @Optional() circuitBreaker?: LlmCircuitBreakerService,
  ) {
    this.circuitBreaker = circuitBreaker ?? new LlmCircuitBreakerService();
  }

  /** 获取关联的熔断器服务实例 */
  getCircuitBreaker(): LlmCircuitBreakerService {
    return this.circuitBreaker;
  }

  /**
   * 动态根据模型配置创建 LangChain ChatOpenAI 实例
   *
   * @param modelName 可选的模型名称覆盖，缺省时读取 ai.llm.default
   * @returns 配置好的 ChatOpenAI 模型客户端
   */
  getModel(modelName?: string): ChatOpenAI {
    const resolved = resolveLlm(this.config, modelName);
    if (resolved.kind === 'custom') {
      throw new Error('The configured LLM provider does not expose a ChatOpenAI model');
    }
    return resolved.model;
  }

  /**
   * 将 StructuredTools 列表绑定到目标 ChatModel 上
   *
   * @param tools 经过适配的 StructuredTool 列表
   * @param model 可选的模型名称或已有 ChatOpenAI 实例
   * @returns 带有 Function Calling 工具约定的 RunnableBinding
   */
  bindTools(tools: StructuredTool[], model?: string | ChatOpenAI) {
    const chatModel = typeof model === 'object' && model !== null
      ? model
      : this.getModel(model);
    return chatModel.bindTools(tools);
  }

  /**
   * 执行单轮决策规划（内置主备模型 Fallback、单次超时守卫与熔断保护）
   */
  async plan(
    messages: LlmMessage[],
    tools: StructuredTool[],
    options: LangChainPlanOptions = {},
  ): Promise<LangChainPlanResult> {
    const { value, modelKey, fallbacks } = await this.executeWithResilience(
      options,
      async (resolved, attemptSignal, callbacks) => {
        if (resolved.kind === 'custom') {
          return this.planWithProvider(resolved, messages, tools, attemptSignal);
        }
        return this.planWithLangChain(resolved, messages, tools, options, attemptSignal, callbacks);
      },
    );

    return {
      ...value,
      model: modelKey,
      ...(fallbacks.length ? { fallbacks } : {}),
    };
  }

  /**
   * 弹性纯对话调用（供 POST /api/ai/chat 复用同一套参数、超时、Fallback 与熔断能力）
   */
  async chat(
    messages: LlmMessage[],
    options: ResilientChatOptions = {},
  ): Promise<LlmChatResult> {
    const { value } = await this.executeWithResilience(
      options,
      async (resolved, attemptSignal) => {
        if (resolved.kind === 'custom') {
          const result = await resolved.provider.chat(messages, {
            model: resolved.modelKey,
            tools: options.tools,
            signal: attemptSignal,
            temperature: resolved.params.temperature,
            ...(resolved.params.maxTokens !== undefined ? { maxTokens: resolved.params.maxTokens } : {}),
            ...(resolved.params.topP !== undefined ? { topP: resolved.params.topP } : {}),
            ...(resolved.params.timeoutMs !== undefined ? { timeoutMs: resolved.params.timeoutMs } : {}),
          });
          if (Symbol.asyncIterator in result) {
            let output = '';
            for await (const chunk of result) {
              if (attemptSignal?.aborted) {
                throw createAbortError('Chat stream aborted');
              }
              output += chunk;
            }
            return { output };
          }
          return result;
        }

        const lcMessages = toLangChainMessages(messages);
        const callConfig = attemptSignal ? { signal: attemptSignal } : undefined;
        const aiMessage = await resolved.model.invoke(lcMessages, callConfig);
        const output = typeof aiMessage.content === 'string'
          ? aiMessage.content
          : JSON.stringify(aiMessage.content ?? '');
        const metadata = aiMessage.usage_metadata;
        const usage = metadata ? {
          inputTokens: metadata.input_tokens,
          outputTokens: metadata.output_tokens,
          totalTokens: metadata.total_tokens,
        } : undefined;
        return {
          output,
          message: { role: 'assistant' as const, content: output },
          ...(usage ? { usage } : {}),
        };
      },
    );

    return value;
  }

  /**
   * 弹性流式对话调用（供 POST /api/ai/chat/stream 复用，流式中途失败自动 resetDelta 并切备）
   */
  async chatStream(
    messages: LlmMessage[],
    options: ResilientChatStreamOptions = {},
  ): Promise<LlmChatResult> {
    const { value } = await this.executeWithResilience(
      options,
      async (resolved, attemptSignal, callbacks) => {
        let output = '';
        if (resolved.kind === 'custom') {
          const result = await resolved.provider.chat(messages, {
            model: resolved.modelKey,
            tools: options.tools,
            stream: true,
            signal: attemptSignal,
            temperature: resolved.params.temperature,
            ...(resolved.params.maxTokens !== undefined ? { maxTokens: resolved.params.maxTokens } : {}),
            ...(resolved.params.topP !== undefined ? { topP: resolved.params.topP } : {}),
            ...(resolved.params.timeoutMs !== undefined ? { timeoutMs: resolved.params.timeoutMs } : {}),
          });
          if (Symbol.asyncIterator in result) {
            for await (const chunk of result) {
              if (attemptSignal?.aborted) {
                throw createAbortError('Chat stream aborted');
              }
              output += chunk;
              if (chunk && options.onDelta) {
                callbacks.markDeltaEmitted();
                await options.onDelta(chunk);
              }
            }
            return { output };
          }
          output = result.output;
          if (output && options.onDelta) {
            callbacks.markDeltaEmitted();
            await options.onDelta(output);
          }
          return result;
        }

        const callConfig = attemptSignal ? { signal: attemptSignal } : undefined;
        const stream = await resolved.model.stream(toLangChainMessages(messages), callConfig);
        for await (const chunk of stream) {
          if (attemptSignal?.aborted) {
            throw createAbortError('Chat stream aborted');
          }
          const text = this.extractDeltaChunkText(chunk.content);
          if (text) {
            output += text;
            if (options.onDelta) {
              callbacks.markDeltaEmitted();
              await options.onDelta(text);
            }
          }
        }
        return { output };
      },
    );

    return value;
  }

  private async executeWithResilience<T>(
    options: ResilienceRunOptions,
    runAttempt: (
      resolved: ResolvedLlm,
      attemptSignal: AbortSignal | undefined,
      callbacks: AttemptCallbacks,
    ) => Promise<T>,
  ): Promise<{ value: T; modelKey: string; fallbacks: LlmFallbackEvent[] }> {
    if (options.signal?.aborted) {
      throw createAbortError('Planner invocation aborted');
    }

    const { candidates } = resolveLlmCandidates(this.config, options.model, options.fallbacks);
    const hasFallbacks = candidates.length > 1;
    const cbPolicy = resolveCircuitBreakerConfig(this.config, hasFallbacks);
    const fallbacks: LlmFallbackEvent[] = [];
    let lastError: unknown;

    for (let i = 0; i < candidates.length; i++) {
      if (options.signal?.aborted) {
        throw createAbortError('Planner invocation aborted');
      }

      const candidateKey = candidates[i];
      const nextModel = candidates[i + 1];
      const acquired = this.circuitBreaker.tryAcquire(candidateKey, cbPolicy);

      if (!acquired.allowed) {
        lastError = new LlmCircuitOpenError(candidateKey, acquired.nextAttemptAt);
        if (nextModel) {
          const event: LlmFallbackEvent = {
            fromModel: candidateKey,
            toModel: nextModel,
            reason: 'circuit_open',
            code: 'LLM_CIRCUIT_OPEN',
            circuitState: acquired.state,
            attempt: i + 1,
          };
          fallbacks.push(event);
          await options.onFallback?.(event);
          continue;
        }
        throw lastError;
      }

      const { isProbe } = acquired;
      let resolved: ResolvedLlm;
      try {
        resolved = resolveLlm(this.config, candidateKey, {
          temperature: options.temperature,
          maxTokens: options.maxTokens,
          topP: options.topP,
          timeoutMs: options.timeoutMs,
          timeout: options.timeout,
          maxRetries: options.maxRetries,
          hasFallbacks,
        });
      } catch (configError) {
        this.circuitBreaker.releaseProbe(candidateKey, isProbe);
        throw configError;
      }

      const timeoutMs = resolved.params.timeoutMs;
      const needsController = Boolean(options.signal || (timeoutMs !== undefined && timeoutMs > 0));
      let attemptController: AbortController | undefined;
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      let onCallerAbort: (() => void) | undefined;
      let timeoutPromise: Promise<never> | undefined;

      if (needsController) {
        attemptController = new AbortController();
        if (options.signal) {
          onCallerAbort = () => attemptController!.abort(options.signal?.reason);
          if (options.signal.aborted) {
            attemptController.abort(options.signal.reason);
          } else {
            options.signal.addEventListener('abort', onCallerAbort, { once: true });
          }
        }
        if (timeoutMs !== undefined && timeoutMs > 0) {
          timeoutPromise = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              const timeoutErr = new Error(`LLM request timed out after ${timeoutMs}ms`);
              timeoutErr.name = 'TimeoutError';
              attemptController!.abort(timeoutErr);
              reject(timeoutErr);
            }, timeoutMs);
            timer.unref?.();
          });
        }
      }

      let deltaPending = false;
      const callbacks: AttemptCallbacks = {
        markDeltaEmitted: () => {
          deltaPending = true;
        },
        markDeltaReset: () => {
          deltaPending = false;
        },
      };

      try {
        const attemptPromise = runAttempt(resolved, attemptController?.signal, callbacks);
        if (timeoutPromise) {
          attemptPromise.catch(() => undefined);
        }
        const value = timeoutPromise
          ? await Promise.race([attemptPromise, timeoutPromise])
          : await attemptPromise;

        this.circuitBreaker.recordSuccess(candidateKey, isProbe);
        return { value, modelKey: candidateKey, fallbacks };
      } catch (err: unknown) {
        if (options.signal?.aborted) {
          this.circuitBreaker.releaseProbe(candidateKey, isProbe);
          throw err;
        }

        const classification = classifyLlmError(err, timedOut);
        if (!classification.retryable) {
          this.circuitBreaker.releaseProbe(candidateKey, isProbe);
          throw this.formatAttemptError(resolved, err);
        }

        const circuitState = this.circuitBreaker.recordFailure(
          candidateKey,
          cbPolicy,
          classification.code,
          isProbe,
        );

        if (deltaPending) {
          deltaPending = false;
          await options.resetDelta?.();
        }

        lastError = this.formatAttemptError(resolved, err);
        if (nextModel && classification.reason) {
          const event: LlmFallbackEvent = {
            fromModel: candidateKey,
            toModel: nextModel,
            reason: classification.reason,
            code: classification.code,
            ...(classification.statusCode !== undefined ? { statusCode: classification.statusCode } : {}),
            circuitState,
            attempt: i + 1,
          };
          fallbacks.push(event);
          await options.onFallback?.(event);
          continue;
        }
        throw lastError;
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
        if (options.signal && onCallerAbort) {
          options.signal.removeEventListener('abort', onCallerAbort);
        }
      }
    }

    throw lastError ?? new Error('All configured LLM candidates failed');
  }

  private async planWithLangChain(
    resolved: Extract<ResolvedLlm, { kind: 'langchain' }>,
    messages: LlmMessage[],
    tools: StructuredTool[],
    options: LangChainPlanOptions,
    attemptSignal: AbortSignal | undefined,
    callbacks: AttemptCallbacks,
  ): Promise<LangChainPlanResult> {
    // 1. 转换消息为 LangChain 标准消息体系
    const lcMessages = toLangChainMessages(messages);
    // 2. 绑定工具并触发模型推理
    const boundModel = this.bindTools(tools, resolved.model);

    let aiMessage: AIMessage;
    let emittedDelta = false;
    let didResetDelta = false;
    const callConfig = attemptSignal ? { signal: attemptSignal } : undefined;

    if (options.onDelta && typeof (boundModel as { stream?: unknown }).stream === 'function') {
      const stream = await (boundModel as {
        stream: (input: BaseMessage[], config?: { signal?: AbortSignal }) => Promise<AsyncIterable<AIMessageChunk>> | AsyncIterable<AIMessageChunk>;
      }).stream(lcMessages, callConfig);
      let aggregated: AIMessageChunk | undefined;
      let sawToolCalls = false;

      for await (const chunk of stream) {
        if (attemptSignal?.aborted) {
          throw createAbortError('Planner stream aborted');
        }
        aggregated = aggregated ? aggregated.concat(chunk) : chunk;
        const hasChunkToolCalls = (Array.isArray(chunk.tool_call_chunks) && chunk.tool_call_chunks.length > 0)
          || (Array.isArray(chunk.tool_calls) && chunk.tool_calls.length > 0)
          || this.extractAdditionalToolCalls(chunk as unknown as AIMessage).length > 0;
        if (hasChunkToolCalls) {
          sawToolCalls = true;
          if (emittedDelta && !didResetDelta) {
            didResetDelta = true;
            callbacks.markDeltaReset();
            await options.resetDelta?.();
          }
        } else if (!sawToolCalls) {
          const text = this.extractDeltaChunkText(chunk.content);
          if (text) {
            emittedDelta = true;
            callbacks.markDeltaEmitted();
            await options.onDelta(text);
          }
        }
      }
      aiMessage = (aggregated ?? new AIMessage('')) as unknown as AIMessage;
    } else {
      aiMessage = (await boundModel.invoke(lcMessages, callConfig)) as AIMessage;
    }

    // 读取模型供应商上报的实际用量，保留到规划结果中。
    const metadata = aiMessage.usage_metadata;
    const usage = metadata && {
      inputTokens: metadata.input_tokens,
      outputTokens: metadata.output_tokens,
      totalTokens: metadata.total_tokens,
    };

    // 3. 优先解析原生 tool_calls（兼顾 aiMessage.tool_calls 与 additional_kwargs）
    const rawToolCalls = (Array.isArray(aiMessage.tool_calls) && aiMessage.tool_calls.length > 0)
      ? aiMessage.tool_calls
      : this.extractAdditionalToolCalls(aiMessage);

    if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {
      if (emittedDelta && !didResetDelta) {
        didResetDelta = true;
        callbacks.markDeltaReset();
        await options.resetDelta?.();
      }
      return { ...this.handleNativeToolCalls(rawToolCalls, aiMessage.content), usage };
    }

    // 4. 纯文本输出与 JSON 兜底解析
    const content = this.extractContentString(aiMessage.content);
    const fallbackResult = this.parseJsonFallback(content);
    if (fallbackResult) {
      if (fallbackResult.toolCalls?.length && emittedDelta && !didResetDelta) {
        didResetDelta = true;
        callbacks.markDeltaReset();
        await options.resetDelta?.();
      }
      return { ...fallbackResult, usage };
    }

    // 5. 直接产出最终回答
    return {
      usage,
      finalAnswer: content,
      response: { role: 'assistant', content },
      planner: 'langchain',
    };
  }

  private formatAttemptError(resolved: ResolvedLlm, err: unknown): Error {
    if (resolved.kind === 'custom') {
      return err instanceof Error ? err : new Error(String(err));
    }
    const error = err as Error;
    const targetEndpoint = resolved.model.clientConfig.baseURL || 'https://api.openai.com/v1';
    const planError = new Error(
      `LangChain planner invocation failed for model "${resolved.model.model}" ` +
      `at endpoint "${targetEndpoint}": ${error?.message || String(err)}`,
    );
    (planError as unknown as { cause?: unknown }).cause = err;
    return planError;
  }

  private extractDeltaChunkText(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map(part => (typeof part === 'string'
          ? part
          : (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
            ? (part as { text: string }).text
            : '')))
        .join('');
    }
    return '';
  }

  private async planWithProvider(
    resolved: Extract<ResolvedLlm, { kind: 'custom' }>,
    messages: LlmMessage[],
    tools: StructuredTool[],
    attemptSignal: AbortSignal | undefined,
  ): Promise<LangChainPlanResult> {
    const result = await resolved.provider.chat(messages, {
      model: resolved.modelKey,
      signal: attemptSignal,
      temperature: resolved.params.temperature,
      ...(resolved.params.maxTokens !== undefined ? { maxTokens: resolved.params.maxTokens } : {}),
      ...(resolved.params.topP !== undefined ? { topP: resolved.params.topP } : {}),
      ...(resolved.params.timeoutMs !== undefined ? { timeoutMs: resolved.params.timeoutMs } : {}),
      tools: tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.schema,
        },
      })),
    });
    if (Symbol.asyncIterator in result) {
      throw new Error('Planner requires a non-streaming LLM response');
    }

    const response: LlmAssistantMessage = result.message ?? {
      role: 'assistant',
      content: result.output,
    };
    if (response.tool_calls?.length) {
      const toolCalls = this.formatToolCalls(response.tool_calls.map((call) => ({
        id: call.id,
        name: call.function.name,
        args: call.function.arguments,
      })));
      return { toolCalls, response, planner: 'langchain', usage: result.usage };
    }

    return { finalAnswer: response.content ?? result.output, response, planner: 'langchain', usage: result.usage };
  }

  /**
   * 从 AIMessage 的 additional_kwargs 中提取兼容模式的 tool_calls
   *
   * @param aiMessage LangChain AI 消息对象
   * @returns 规整后的工具调用列表
   */
  private extractAdditionalToolCalls(
    aiMessage: AIMessage,
  ): Array<{ id?: string; name: string; args?: unknown }> {
    const rawCalls = (aiMessage.additional_kwargs as {
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    })?.tool_calls;

    if (!Array.isArray(rawCalls) || rawCalls.length === 0) {
      return [];
    }

    return rawCalls
      .filter((tc) => Boolean(tc?.function?.name))
      .map((tc) => ({
        id: tc.id,
        name: tc.function!.name!,
        args: tc.function?.arguments,
      }));
  }

  /**
   * 处理原生 Tool Calls 返回，封装标准调用结构与回填助手机器人消息
   *
   * @param rawToolCalls 模型返回的原生 tool_calls
   * @param content 模型伴随的文本回复
   * @returns LangChainPlanResult
   */
  private handleNativeToolCalls(
    rawToolCalls: Array<{ id?: string; name: string; args?: unknown }>,
    content: unknown,
  ): LangChainPlanResult {
    const toolCalls = this.formatToolCalls(rawToolCalls);
    const contentStr = typeof content === 'string' && content.trim() ? content : null;
    const assistantMessage: LlmAssistantMessage = {
      role: 'assistant',
      content: contentStr,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args),
        },
      })),
    };

    return {
      toolCalls,
      response: assistantMessage,
      planner: 'langchain',
    };
  }

  /**
   * 将模型返回的原始 tool_calls 格式化为标准结构
   *
   * @param rawToolCalls 原始工具调用项
   * @returns 规整后的 LangChainToolCall 数组
   */
  private formatToolCalls(
    rawToolCalls: Array<{ id?: string; name: string; args?: unknown }>,
  ): LangChainToolCall[] {
    return rawToolCalls.map((tc) => ({
      id: tc.id ?? `call-${Date.now()}`,
      name: tc.name,
      args: this.parseToolCallArgs(tc.args),
    }));
  }

  /**
   * 安全解析工具调用的实参（处理字符串化 JSON 异常）
   *
   * @param rawArgs 原始实参对象或 JSON 字符串
   * @returns 解析后的 JavaScript 对象
   */
  private parseToolCallArgs(rawArgs: unknown): Record<string, unknown> | unknown {
    if (typeof rawArgs === 'string') {
      try {
        return JSON.parse(rawArgs);
      } catch {
        return extractJson(rawArgs) ?? {};
      }
    }
    return rawArgs ?? {};
  }

  /**
   * 提取助手回复的纯文本内容，处理多模态或复杂数组格式
   *
   * @param content 原始 content
   * @returns 文本字符串
   */
  private extractContentString(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return JSON.stringify(content);
    }
    return String(content ?? '');
  }

  /**
   * 从模型文本中解析 JSON 兜底协议（针对无法产生原生 tool_calls 的模型）
   *
   * @param content 助手文本
   * @returns 解析出的规划结果，未匹配返回 null
   */
  private parseJsonFallback(content: string): LangChainPlanResult | null {
    const parsedJson = extractJson<JsonPlan>(content);
    if (!parsedJson || typeof parsedJson !== 'object') {
      return null;
    }

    const isCallAction = parsedJson.action === 'call'
      || parsedJson.action === 'skill'
      || parsedJson.action === 'tool'
      || parsedJson.action === 'invoke';

    // 命中约定工具调用：{"action":"call", "name":..., "input":...}
    if (isCallAction && typeof parsedJson.name === 'string' && parsedJson.name) {
      const toolCallId = `fallback-${Date.now()}`;
      const input = parsedJson.input ?? {};
      const assistantMessage: LlmAssistantMessage = {
        role: 'assistant',
        content,
        tool_calls: [{
          id: toolCallId,
          type: 'function',
          function: {
            name: parsedJson.name,
            arguments: typeof input === 'string' ? input : JSON.stringify(input),
          },
        }],
      };
      return {
        toolCalls: [{ id: toolCallId, name: parsedJson.name, args: input }],
        response: assistantMessage,
        planner: 'langchain',
      };
    }

    // 命中约定最终结论：{"action":"final", "response":"..."}
    if (parsedJson.action === 'final' && typeof parsedJson.response === 'string') {
      return {
        finalAnswer: parsedJson.response,
        response: { role: 'assistant', content: parsedJson.response },
        planner: 'langchain',
      };
    }

    return null;
  }
}
