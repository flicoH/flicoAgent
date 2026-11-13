import { Injectable } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import {
  AIMessage,
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
} from '../../llm/llm.interface';

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
  /** 若模型判定需要执行能力，返回待调用的工具指令列表 */
  toolCalls?: LangChainToolCall[];
  /** 若模型认为信息足够回答，返回最终文本结论 */
  finalAnswer?: string;
  /** 模型原装助手机器人回复实体（原样回填对话上下文） */
  response?: LlmAssistantMessage;
  /** 明确标识由 LangChain 规划器驱动 */
  planner: 'langchain';
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
 * 常用国内/主流大模型提供商的默认 OpenAI-compatible 端点及模型名映射
 */
const KNOWN_MODEL_DEFAULTS: Record<string, { baseURL: string; model: string }> = {
  kimi: {
    baseURL: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2.6',
  },
  moonshot: {
    baseURL: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2.6',
  },
  qwen: {
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  },
  deepseek: {
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
};

/**
 * 解析并规格化目标大模型的连接配置 (apiKey, model, baseURL)
 *
 * 【解析优先级与兜底策略】
 * 1. baseURL: 业务显式配置 > 已知厂商映射 (kimi/qwen/deepseek) > 自定义 Provider 推断 (KimiProvider) > 环境变量 OPENAI_BASE_URL
 * 2. model: 业务显式配置 > 已知厂商默认模型 > 自定义 Provider 推断 > selectedModel (非 kimi 别名) > 'gpt-4o'
 * 3. apiKey: 业务非占位配置 > 环境变量 OPENAI_API_KEY > 'mock-api-key'
 *
 * @param selectedModel 选中的模型标识名称（如 'kimi', 'qwen', 'gpt-4o'）
 * @param modelConfig 在 ai.llm.models 中声明的原始配置对象
 * @returns 规整完毕的连接配置参数
 */
export function resolveModelEndpoint(
  selectedModel?: string,
  modelConfig?: {
    apiKey?: string;
    baseURL?: string;
    model?: string;
    provider?: string;
    use?: unknown;
  },
): {
  apiKey: string;
  model: string;
  baseURL?: string;
} {
  const modelKey = (selectedModel ?? '').toLowerCase();
  const matchedDefault = KNOWN_MODEL_DEFAULTS[modelKey];

  // 1. 判断是否自定义注入了已知的 Provider（例如 KimiProvider）
  const useConstructorName = typeof modelConfig?.use === 'function'
    ? modelConfig.use.name
    : typeof modelConfig?.use === 'object' && modelConfig?.use !== null
      ? (modelConfig.use as { constructor?: { name?: string } }).constructor?.name
      : undefined;
  const isKimiProvider = useConstructorName === 'KimiProvider'
    || String(modelConfig?.use).includes('Kimi')
    || String(modelConfig?.use).includes('moonshot');

  // 2. 依次解析 baseURL：明确配置 > 已知厂商兜底 > 自定义 Provider 推断 > 环境变量
  const baseURL = modelConfig?.baseURL
    ?? matchedDefault?.baseURL
    ?? (isKimiProvider ? 'https://api.moonshot.cn/v1' : undefined)
    ?? process.env.OPENAI_BASE_URL
    ?? process.env.OPENAI_API_BASE
    ?? undefined;

  // 3. 依次解析 model：明确配置 > 已知厂商默认模型 > 自定义 Provider 推断 > 模型标识 > 'gpt-4o'
  const model = modelConfig?.model
    ?? matchedDefault?.model
    ?? (isKimiProvider ? 'kimi-k2.6' : undefined)
    ?? (selectedModel && selectedModel !== 'kimi' ? selectedModel : undefined)
    ?? 'gpt-4o';

  // 4. 解析 apiKey：配置值（排查 'xxxx' 占位符） > 环境变量 > 兜底
  const rawApiKey = modelConfig?.apiKey;
  const apiKey = (rawApiKey && rawApiKey !== 'xxxx')
    ? rawApiKey
    : (process.env.OPENAI_API_KEY || 'mock-api-key');

  return { apiKey, model, baseURL };
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
 * 4. 严禁引入 `runtime/planner.service.ts`，保持独立性。
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
    const llm = this.config.get<any>('ai.llm');
    const selectedModel = modelName ?? llm?.default;
    const modelConfig = selectedModel ? llm?.models?.[selectedModel] : undefined;

    const resolved = resolveModelEndpoint(selectedModel, modelConfig);

    return new ChatOpenAI({
      apiKey: resolved.apiKey,
      model: resolved.model,
      configuration: resolved.baseURL ? { baseURL: resolved.baseURL } : undefined,
      temperature: 0,
      maxRetries: 2,
    });
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
    options: { model?: string } = {},
  ): Promise<LangChainPlanResult> {
    // 1. 转换消息为 LangChain 标准消息体系
    const lcMessages = toLangChainMessages(messages);
    // 2. 绑定工具并触发模型推理
    const boundModel = this.bindTools(tools, options.model);

    let rawResponse: unknown;
    try {
      rawResponse = await boundModel.invoke(lcMessages);
    } catch (err: unknown) {
      const error = err as Error;
      const llm = this.config.get<any>('ai.llm');
      const selectedModel = options.model ?? llm?.default;
      const modelConfig = selectedModel ? llm?.models?.[selectedModel] : undefined;
      const resolved = resolveModelEndpoint(selectedModel, modelConfig);
      const targetEndpoint = resolved.baseURL || 'https://api.openai.com/v1';

      const planError = new Error(
        `LangChain planner invocation failed for model "${resolved.model}" ` +
        `at endpoint "${targetEndpoint}": ${error?.message || String(err)}`,
      );
      (planError as unknown as { cause?: unknown }).cause = err;
      throw planError;
    }

    const aiMessage = rawResponse as AIMessage;

    // 3. 优先解析原生 tool_calls（兼顾 aiMessage.tool_calls 与 additional_kwargs）
    const rawToolCalls = (Array.isArray(aiMessage.tool_calls) && aiMessage.tool_calls.length > 0)
      ? aiMessage.tool_calls
      : this.extractAdditionalToolCalls(aiMessage);

    if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {
      return this.handleNativeToolCalls(rawToolCalls, aiMessage.content);
    }

    // 4. 纯文本输出与 JSON 兜底解析
    const content = this.extractContentString(aiMessage.content);
    const fallbackResult = this.parseJsonFallback(content);
    if (fallbackResult) {
      return fallbackResult;
    }

    // 5. 直接产出最终回答
    return {
      finalAnswer: content,
      response: { role: 'assistant', content },
      planner: 'langchain',
    };
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
