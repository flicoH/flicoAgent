import { normalizeTokenUsage } from '../internal/token-usage';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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

interface PlanOptions {
  model?: string;
  signal?: AbortSignal;
  onDelta?: (content: string) => Promise<void> | void;
  resetDelta?: () => Promise<void> | void;
}

/**
 * 针对不支持原生 Function Calling 的模型或旧版模型的 JSON 兜底结构
 */
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
 * 3. 在规划步骤中明确注入 `planner: 'langchain'` 标识。
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
    if (resolved.kind === 'custom') throw new Error('The configured provider does not expose a LangChain model');
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
    messages: (LlmMessage | BaseMessage)[],
    tools: StructuredTool[],
    options: PlanOptions = {},
  ): Promise<LangChainPlanResult> {
    const resolved = resolveLlm(this.config, options.model);
    if (resolved.kind === 'custom') {
      const result = await this.planWithProvider(resolved.provider, messages, tools, options);
      await this.reconcileStream(result.finalAnswer, '', options);
      return result;
    }

    const lcMessages = toLangChainMessages(messages);
    const boundModel = this.bindTools(tools, resolved.model);

    let completion: { message: AIMessage; emitted: string };
    try {
      completion = options.onDelta
        ? await this.collectStream(await boundModel.stream(lcMessages, { signal: options.signal }), options.onDelta)
        : { message: await boundModel.invoke(lcMessages, { signal: options.signal }), emitted: '' };
    } catch (err: unknown) {
      options.signal?.throwIfAborted();
      throw this.createInvocationError(resolved.model, err);
    }

    const result = this.parsePlan(completion.message);
    await this.reconcileStream(result.finalAnswer, completion.emitted, options);
    const usage = completion.message.usage_metadata;
    const tokens = normalizeTokenUsage(usage?.input_tokens, usage?.output_tokens, usage?.total_tokens);
    return tokens ? { ...result, usage: tokens } : result;
  }

  /**
   * 合并模型片段，返回完整消息和已经发送的文本。
   * 发现工具调用后暂停发送文本。以 JSON 对象或代码围栏开头的内容留到整轮解析。
   */
  private async collectStream(
    stream: AsyncIterable<AIMessageChunk>,
    onDelta: NonNullable<PlanOptions['onDelta']>,
  ): Promise<{ message: AIMessage; emitted: string }> {
    let combined: AIMessageChunk | undefined;
    let text = '';
    let emitted = '';
    let hasToolCalls = false;
    for await (const chunk of stream) {
      combined = combined ? combined.concat(chunk) : chunk;
      hasToolCalls ||= Boolean(chunk.tool_call_chunks?.length || chunk.tool_calls?.length);
      text += this.extractContentString(chunk.content);
      // JSON 兜底规划指令需要等完整消息解析，暂缓将其显示为回答。
      const leadingText = text.trimStart();
      if (!hasToolCalls && text.length > emitted.length && leadingText && !/^[{`]/.test(leadingText)) {
        await onDelta(text.slice(emitted.length));
        emitted = text;
      }
    }
    return { message: combined ?? new AIMessage(''), emitted };
  }

  /** 两种调用模式共用解析规则，优先使用原生工具调用，再尝试 JSON 兜底。 */
  private parsePlan(aiMessage: AIMessage): LangChainPlanResult {
    const rawToolCalls = (Array.isArray(aiMessage.tool_calls) && aiMessage.tool_calls.length > 0)
      ? aiMessage.tool_calls
      : this.extractAdditionalToolCalls(aiMessage);

    if (rawToolCalls.length > 0) return this.handleNativeToolCalls(rawToolCalls, aiMessage.content);
    const content = this.extractContentString(aiMessage.content);
    return this.parseJsonFallback(content) ?? {
      finalAnswer: content,
      response: { role: 'assistant', content },
      planner: 'langchain',
    };
  }

  /**
   * 如果已发送的文本仍是最终答案的前缀，只补发剩余部分。
   * 如果模型转为调用工具或最终答案与此前文本不一致，先发出重置信号。
   */
  private async reconcileStream(answer: string | undefined, emitted: string, options: PlanOptions): Promise<void> {
    if (emitted && !answer?.startsWith(emitted)) {
      await options.resetDelta?.();
      emitted = '';
    }
    if (answer && answer.length > emitted.length) {
      await options.onDelta?.(answer.slice(emitted.length));
    }
  }

  private async planWithProvider(
    provider: LlmProvider,
    messages: (LlmMessage | BaseMessage)[],
    tools: StructuredTool[],
    options: PlanOptions,
  ): Promise<LangChainPlanResult> {
    options.signal?.throwIfAborted();
    const result = await provider.chat(messages.map(message => this.toProviderMessage(message)), {
      tools: tools.map(({ name, description, schema }) => ({
        type: 'function',
        function: { name, description, parameters: schema },
      })),
      signal: options.signal,
    });
    options.signal?.throwIfAborted();
    if (Symbol.asyncIterator in result) {
      throw new Error('LLM provider returned a stream for a non-streaming request');
    }

    const response = result.message ?? { role: 'assistant', content: result.output };
    const calls = response.tool_calls?.map(call => ({
      id: call.id,
      name: call.function.name,
      args: call.function.arguments,
    }));
    let plan: LangChainPlanResult = {
      finalAnswer: response.content ?? result.output,
      response,
      planner: 'langchain',
    };
    if (calls?.length) {
      const toolCalls = this.formatToolCalls(calls);
      plan = {
        toolCalls,
        response: {
          ...response,
          tool_calls: response.tool_calls?.map((call, index) => ({ ...call, id: toolCalls[index].id })),
        },
        planner: 'langchain',
      };
    }
    return result.usage ? { ...plan, usage: result.usage } : plan;
  }

  private toProviderMessage(message: LlmMessage | BaseMessage): LlmMessage {
    if (!(message instanceof BaseMessage)) return message;
    const content = this.extractContentString(message.content);
    if (message instanceof AIMessage) {
      const calls = message.tool_calls?.length ? message.tool_calls : this.extractAdditionalToolCalls(message);
      return calls.length
        ? this.handleNativeToolCalls(calls, content).response!
        : { role: 'assistant', content };
    }
    if (message instanceof ToolMessage) return { role: 'tool', content, tool_call_id: message.tool_call_id };
    return { role: message instanceof SystemMessage ? 'system' : 'user', content };
  }

  /** 保留具体模型，方便排查上游调用错误。 */
  private createInvocationError(model: ChatOpenAI, cause: unknown): Error {
    const endpoint = model.clientConfig.baseURL || 'https://api.openai.com/v1';
    const message = (cause as Error | undefined)?.message || String(cause);
    return new Error(
      `LangChain planner invocation failed for model "${model.model}" at endpoint "${endpoint}": ${message}`,
      { cause },
    );
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
    const ids = new Set<string>();
    return rawToolCalls.map(tc => {
      // 兼容没有工具 ID 的模型，保证同轮多调用的回填 ID 唯一。
      const id = tc.id && !ids.has(tc.id) ? tc.id : `call-${randomUUID()}`;
      ids.add(id);
      return { id, name: tc.name, args: this.parseToolCallArgs(tc.args) };
    });
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
        return rawArgs;
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
      return content.map(block => typeof block === 'string'
        ? block
        : block?.type === 'text' && typeof block.text === 'string' ? block.text : '').join('');
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
      const toolCallId = `fallback-${randomUUID()}`;
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
