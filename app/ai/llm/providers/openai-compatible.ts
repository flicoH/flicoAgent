import axios, { AxiosProxyConfig, AxiosRequestConfig } from 'axios';
import type { Readable } from 'node:stream';
import {
  LlmAssistantMessage,
  LlmChatOptions,
  LlmChatResult,
  LlmMessage,
  LlmProvider,
} from '../llm.interface';

/**
 * OpenAI 兼容提供商初始化参数
 */
interface OpenAiCompatibleConfig {
  /** API 服务根路径 */
  baseURL: string;
  /** 上游模型名称，如 'qwen-plus' */
  model: string;
  /** 鉴权 Token (Bearer Token) */
  apiKey: string;
  /** 网络代理配置（国内 endpoint 默认自动 bypass 本地 proxy） */
  proxy?: false | AxiosProxyConfig;
}

/**
 * 非流式 Chat Completions 接口的响应结构
 */
interface ChatCompletionResponse {
  choices?: Array<{
    message?: LlmAssistantMessage;
  }>;
}

/**
 * 流式 SSE (Server-Sent Events) 数据块的数据结构
 */
interface ChatCompletionChunk {
  choices?: Array<{
    delta?: { content?: string };
  }>;
}

/**
 * 框架内置通用 OpenAI 兼容模型提供者 (OpenAiCompatibleProvider)
 *
 * 【设计定位】
 * 覆盖通义千问、DeepSeek、Moonshot、智谱等绝大多数支持 OpenAI 协议规范的云端及本地大模型：
 * 1. 支持标准 Chat Completions 非流式调用；
 * 2. 支持 SSE 流式调用，自动处理多分块粘包/拆包，逐段产出文本流；
 * 3. 请求中透传 Function Calling (tools) 结构，非流式响应保留 assistant 消息；
 * 4. 严格遵守 LlmProvider 契约。
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  /**
   * 构造函数
   * @param config 连接与模型配置
   */
  constructor(private readonly config: OpenAiCompatibleConfig) {}

  /**
   * 发起对话调用
   * 依据 options.stream 决定走非流式完整响应还是 SSE 异步迭代器
   *
   * @param messages 历史对话消息
   * @param options 选项覆盖
   * @returns 非流式返回 Promise<LlmChatResult>，流式返回 AsyncIterable<string>
   */
  chat(
    messages: LlmMessage[],
    options: LlmChatOptions = {},
  ): Promise<LlmChatResult> | AsyncIterable<string> {
    return options.stream
      ? this.stream(messages, options)
      : this.complete(messages, options);
  }

  private axiosOptions(extra: AxiosRequestConfig = {}): AxiosRequestConfig {
    const isDomestic = this.config.baseURL.includes('aliyuncs.com');
    const proxy = this.config.proxy !== undefined ? this.config.proxy : (isDomestic ? false : undefined);
    return {
      headers: this.headers(),
      ...(proxy !== undefined ? { proxy } : {}),
      ...extra,
    };
  }

  /**
   * 处理非流式请求
   *
   * @param messages 对话消息列表
   * @param options 调用选项
   * @returns 统一结构化结果
   */
  private async complete(
    messages: LlmMessage[],
    options: LlmChatOptions,
  ): Promise<LlmChatResult> {
    const response = await axios.post<ChatCompletionResponse>(
      this.endpoint(),
      this.requestBody(messages, options, false),
      this.axiosOptions(),
    );
    const message = response.data.choices?.[0]?.message;
    if (!message || message.role !== 'assistant') {
      throw new Error('OpenAI-compatible response does not contain an assistant message');
    }
    const output = message.content ?? '';
    return { output, message };
  }

  /**
   * 处理流式请求，逐块消费上游 SSE 并转换为字符增量迭代器
   *
   * 【流式处理算法】
   * 网络分块传输时无法保证每个 chunk 恰好是一行完整的 SSE 数据。
   * 因此引入行缓冲区 buffer：
   * 1. 拼接 chunk 到 buffer；
   * 2. 按换行符切分为多行；
   * 3. 最后一个片段可能未完结，保留在 buffer 等待下一批数据；
   * 4. 完整的行交由 parseLines 解析；
   * 5. 迭代结束后若 buffer 仍有剩余内容，进行收尾解析。
   *
   * @param messages 对话消息列表
   * @param options 调用选项
   * @returns 异步字符串迭代器
   */
  private async *stream(
    messages: LlmMessage[],
    options: LlmChatOptions,
  ): AsyncIterable<string> {
    const response = await axios.post<Readable>(
      this.endpoint(),
      this.requestBody(messages, options, true),
      this.axiosOptions({ responseType: 'stream' }),
    );
    let buffer = '';

    for await (const chunk of response.data) {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      yield* this.parseLines(lines);
    }

    if (buffer) {
      yield* this.parseLines([buffer]);
    }
  }

  /**
   * 解析 SSE 行数组，提取首个 choice 的文本增量；流式工具调用增量不会在此返回。
   * 每个 data 行按独立 JSON 解析，格式错误会向调用方抛出。
   *
   * @param lines 完整的文本行数组
   * @returns 可迭代的文本增量片段
   */
  private *parseLines(lines: string[]): Iterable<string> {
    for (const line of lines) {
      // 忽略非 data: 开头的行（例如 event, id, retry 或空行）
      if (!line.startsWith('data:')) {
        continue;
      }
      const data = line.slice(5).trim();
      // 忽略空数据及 OpenAI 约定的流结束标识 [DONE]
      if (!data || data === '[DONE]') {
        continue;
      }
      const chunk = JSON.parse(data) as ChatCompletionChunk;
      const content = chunk.choices?.[0]?.delta?.content;
      if (typeof content === 'string' && content) {
        yield content;
      }
    }
  }

  /**
   * 拼接得到标准的 `/chat/completions` API 端点
   */
  private endpoint(): string {
    return `${this.config.baseURL.replace(/\/$/, '')}/chat/completions`;
  }

  /**
   * 构造标准 HTTP 请求头，包含 Bearer 认证及 Content-Type
   */
  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * 构造发送至上游模型的标准请求体
   *
   * @param messages 消息列表
   * @param options 选项
   * @param stream 是否流式
   */
  private requestBody(
    messages: LlmMessage[],
    options: LlmChatOptions,
    stream: boolean,
  ): Record<string, unknown> {
    return {
      model: this.config.model,
      messages,
      ...(options.tools && options.tools.length > 0
        ? { tools: options.tools, tool_choice: 'auto' }
        : {}),
      stream, 
    };
  }
}
