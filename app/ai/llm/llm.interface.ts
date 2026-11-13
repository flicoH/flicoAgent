/**
 * 大模型 Function Calling（工具调用）单项结构
 * 遵循 OpenAI-compatible 规范
 */
export interface LlmToolCall {
  /** 工具调用的唯一标识 ID，模型生成，如 'call_abc123' */
  id: string;
  /** 调用类型，固定为 'function' */
  type: 'function';
  /** 函数调用详细信息 */
  function: {
    /** 调用的目标函数/工具名称 */
    name: string;
    /** JSON 序列化后的实参字符串 */
    arguments: string;
  };
}

/**
 * 普通文本消息（系统提示词 system 或 用户提问 user）
 */
export interface LlmTextMessage {
  /** 角色：'system' 或 'user' */
  role: 'system' | 'user';
  /** 消息文本内容 */
  content: string;
}

/**
 * 模型助手的原始回复消息 (assistant)
 *
 * 【ReAct 循环关键点】
 * 当模型决定调用工具时，其回复中包含 `tool_calls`。
 * 在后续 ReAct 轮次中，该 assistant 消息必须原封不动地放回消息历史，
 * 紧随其后必须是对应的 tool 消息，模型方能正确推演。
 */
export interface LlmAssistantMessage {
  /** 角色：'assistant' */
  role: 'assistant';
  /** 助手文本回复内容，进行工具调用时可能为 null */
  content: string | null;
  /** 模型产出的工具调用指令列表 */
  tool_calls?: LlmToolCall[];
}

/**
 * 工具执行结果消息 (tool)
 * 携带工具执行后的输出，并通过 tool_call_id 与上一条 assistant 消息中的对应 tool_call 严格关联
 */
export interface LlmToolMessage {
  /** 角色：'tool' */
  role: 'tool';
  /** 工具执行的序列化观察结果 */
  content: string;
  /** 对应的工具调用 ID */
  tool_call_id: string;
}

/**
 * 框架统一使用的对话消息联合类型
 */
export type LlmMessage = LlmTextMessage | LlmAssistantMessage | LlmToolMessage;

/**
 * 非流式模型调用的结构化返回结果
 */
export interface LlmChatResult {
  /** 简化、纯净的最终文本输出 */
  output: string;
  /** 原始 assistant 消息（含 tool_calls 等元数据），用于回放与多轮会话状态维护 */
  message?: LlmAssistantMessage;
}

/**
 * 单次模型调用时的可选参数覆盖项
 */
export interface LlmChatOptions {
  /** 指定使用的模型配置名称（对应 ai.llm.models 中的 key）；未指定时采用 ai.llm.default */
  model?: string;
  /** 透传给模型的工具/函数定义清单（OpenAI tools 格式） */
  tools?: unknown[];
  /** 是否启用流式输出：true 时返回 AsyncIterable<string>，false 时返回 Promise<LlmChatResult> */
  stream?: boolean;
}

/**
 * 大模型提供者统一接口契约 (LlmProvider)
 *
 * 【多厂商解耦设计】
 * 无论框架内置的 OpenAI-compatible 提供商，还是业务工程自定义实现的本地模型、私有网关或专有云模型，
 * 只要实现该接口，均可无缝接入 Agent 运行时与 Planner 服务。
 */
export interface LlmProvider {
  /**
   * 发起多轮对话请求
   *
   * @param messages 历史对话消息列表
   * @param options 调用选项（如模型名、工具清单、流式开关等）
   * @returns 非流式调用返回完整结果 Promise，流式调用返回异步文本分块迭代器
   */
  chat(
    messages: LlmMessage[],
    options?: LlmChatOptions,
  ): Promise<LlmChatResult> | AsyncIterable<string>;
}
