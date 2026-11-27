import { Injectable } from '@nestjs/common';
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
import { ConfigService } from '../../../config/config.service';
import type {
  LlmAssistantMessage,
  LlmMessage,
  LlmProvider,
  TokenUsage,
} from '../../contracts';
import { resolveLlm } from '../internal/load-llm-config';

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
  /** 明确标识由 LangChain 规划器驱动 */
  planner: 'langchain';
}

export interface LangChainPlanOptions {
  model?: string;
  signal?: AbortSignal;
  onDelta?: (content: string) => void | Promise<void>;
  resetDelta?: () => void | Promise<void>;
}

/**
 * 执行单轮决策规划
 *
 * @param messages 当前完整的多轮消息历史
 * @param tools 开放调用的 StructuredTool 列表
 * @param options 可选配置（模型覆盖、AbortSignal、流式 delta 与 resetDelta 回调）
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

/**
 * 基于 LangChain 的规划器服务 (LangChainPlannerService)
 *
 * 【职责与定位】
 * 在 LangGraph 编排循环中担任核心推理大脑：
 * 1. 采用 LangChain ChatOpenAI + `bindTools` 机制将白名单内的工具注入大模型调用上下文；
 * 2. 规划决策单轮原子输出：要么产出 `toolCalls`，要么给出 `finalAnswer`；
 * 3. 在规划步骤中明确注入 `planner: 'langchain'` 标识；
 * 4. 通过 use 配置的 Provider 直接使用框架对话协议。
 */
@Injectable()
export class LangChainPlannerService {
  /**
   * 构造函数注入全局配置服务
   *
   * @param config 全局统一配置服务
   */
  constructor(private readonly config: ConfigService) {}

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
   * 执行单轮决策规划
   *
   * @param messages 当前完整的多轮消息历史
   * @param tools 开放调用的 StructuredTool 列表
   * @param options 可选配置（如覆盖模型名称）
   * @returns LangChainPlanResult（包含 toolCalls 或 finalAnswer，以及 planner='langchain'）
   */
  async plan(
    messages: LlmMessage[],
    tools: StructuredTool[],
    options: LangChainPlanOptions = {},
  ): Promise<LangChainPlanResult> {
    if (options.signal?.aborted) {
      throw new Error('Planner invocation aborted');
    }

    const resolved = resolveLlm(this.config, options.model);
    if (resolved.kind === 'custom') {
      return this.planWithProvider(resolved.provider, messages, tools, options);
    }

    // 1. 转换消息为 LangChain 标准消息体系
    const lcMessages = toLangChainMessages(messages);
    // 2. 绑定工具并触发模型推理
    const boundModel = this.bindTools(tools, resolved.model);

    let aiMessage: AIMessage;
    let emittedDelta = false;
    let didResetDelta = false;
    const callConfig = options.signal ? { signal: options.signal } : undefined;

    try {
      if (options.onDelta && typeof (boundModel as { stream?: unknown }).stream === 'function') {
        const stream = await (boundModel as {
          stream: (input: BaseMessage[], config?: { signal?: AbortSignal }) => Promise<AsyncIterable<AIMessageChunk>> | AsyncIterable<AIMessageChunk>;
        }).stream(lcMessages, callConfig);
        let aggregated: AIMessageChunk | undefined;
        let sawToolCalls = false;

        for await (const chunk of stream) {
          if (options.signal?.aborted) {
            throw new Error('Planner stream aborted');
          }
          aggregated = aggregated ? aggregated.concat(chunk) : chunk;
          const hasChunkToolCalls = (Array.isArray(chunk.tool_call_chunks) && chunk.tool_call_chunks.length > 0)
            || (Array.isArray(chunk.tool_calls) && chunk.tool_calls.length > 0)
            || this.extractAdditionalToolCalls(chunk as unknown as AIMessage).length > 0;
          if (hasChunkToolCalls) {
            sawToolCalls = true;
            if (emittedDelta && !didResetDelta) {
              didResetDelta = true;
              await options.resetDelta?.();
            }
          } else if (!sawToolCalls) {
            const text = this.extractDeltaChunkText(chunk.content);
            if (text) {
              emittedDelta = true;
              await options.onDelta(text);
            }
          }
        }
        aiMessage = (aggregated ?? new AIMessage('')) as unknown as AIMessage;
      } else {
        aiMessage = (await boundModel.invoke(lcMessages, callConfig)) as AIMessage;
      }
    } catch (err: unknown) {
      if (options.signal?.aborted) {
        throw err;
      }
      const error = err as Error;
      const targetEndpoint = resolved.model.clientConfig.baseURL || 'https://api.openai.com/v1';

      const planError = new Error(
        `LangChain planner invocation failed for model "${resolved.model.model}" ` +
        `at endpoint "${targetEndpoint}": ${error?.message || String(err)}`,
      );
      (planError as unknown as { cause?: unknown }).cause = err;
      throw planError;
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
    provider: LlmProvider,
    messages: LlmMessage[],
    tools: StructuredTool[],
    options: LangChainPlanOptions = {},
  ): Promise<LangChainPlanResult> {
    const result = await provider.chat(messages, {
      model: options.model,
      signal: options.signal,
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
