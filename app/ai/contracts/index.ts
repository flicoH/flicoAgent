/**
 * 规划动作：调用能力 (InvokePlanAction)
 * 表示模型规划出在当前轮次需要执行某个已注册的 Skill 或 Tool
 */
export interface InvokePlanAction {
  /** 动作类型：'invoke' */
  type: 'invoke';
  /** 待调用的技能或工具注册名 */
  name: string;
  /** 传递给技能或工具 execute 方法的参数对象 */
  input: unknown;
}

/**
 * 规划动作：最终产出 (FinalPlanAction)
 * 表示模型认为已有信息足够回答用户提问，结束推理循环
 */
export interface FinalPlanAction {
  /** 动作类型：'final' */
  type: 'final';
  /** 最终回答文本 */
  output: string;
}

/**
 * 单轮规划动作联合类型（只能是“调用能力”或“得出最终结论”）
 */
export type PlanAction = InvokePlanAction | FinalPlanAction;

/**
 * 规划器单轮推理结果 (PlanResult)
 */
export interface PlanResult {
  /** 解析出的决策动作（invoke 或 final） */
  action: PlanAction;
  /** 模型返回的原始助手消息（包含 content 与 tool_calls），必须按原样写回多轮会话历史 */
  response: LlmAssistantMessage;
  /** 本次工具调用的唯一标识 ID（原生 tool_call.id 或 fallback 兜底生成），用于关联对应的 tool 观察结果 */
  toolCallId?: string;
}

/**
 * 执行器单次执行结果 (ExecutionResult)
 */
export interface ExecutionResult {
  /** 命中的能力类别；若在执行前或执行中发生异常则为 'observe' 观察错误 */
  type: 'skill' | 'tool' | 'observe';
  /** 本次执行的能力名称 */
  name: string;
  /** 能力来源分类（如 'builtin' | 'mcp'） */
  source?: 'builtin' | 'mcp';
  /** 成功执行后的输出结果 */
  output?: unknown;
  /** 结构化错误信息（不向循环外抛出异常，而是让下一轮模型感知并自愈） */
  error?: {
    code: string;
    message: string;
  };
}

/**
 * 运行追踪步骤类型枚举
 * - 'plan': 规划动作
 * - 'skill': 业务技能执行
 * - 'tool': 通用工具执行
 * - 'observe': 模型对执行结果的观察事实
 * - 'final': 最终输出步骤
 * - 'guardrail': 安全护栏拦截步骤
 */
export type StepType = 'plan' | 'skill' | 'tool' | 'observe' | 'final' | 'guardrail';

/** 模型供应商报告的单轮用量，或同一次运行中已上报用量的合计。 */
export interface TokenUsage {
  /** 输入消息、历史上下文和工具定义等消耗的 token。 */
  inputTokens: number;
  /** 模型生成内容消耗的 token。 */
  outputTokens: number;
  /** 供应商报告的总 token，汇总时按轮累加。 */
  totalTokens: number;
}

/**
 * 运行轨迹中的单个步骤实体 (Step)
 */
export interface Step {
  /** 模型调用用量。null 表示本轮未上报，缺省表示步骤未记录模型调用。 */
  usage?: TokenUsage | null;
  /** 步骤类型 */
  type: StepType;
  /** 所在循环轮次（从 1 开始递增） */
  iteration: number;
  /** 能力名称（仅在 skill/tool/observe 相关步骤中存在） */
  name?: string;
  /** 工具来源分类（仅在 tool 步骤中存在，'builtin' | 'mcp'） */
  source?: 'builtin' | 'mcp';
  /** 输入数据 */
  input?: unknown;
  /** 输出数据 */
  output?: unknown;
  /** 结构化错误信息 */
  error?: {
    code: string;
    message: string;
  };
  /** 对应的 tool_call_id，用于步骤与对话链路精准匹配 */
  toolCallId?: string;
  /** 步骤产生时的 ISO 时间戳 */
  timestamp: string;
}

/**
 * Agent 运行对外输出的稳定响应合同 (RunResult)
 * 【重要】：runId、output、steps、threadId 字段名称在合同中严格锁死，不得变更
 */
export interface RunResult {
  /** 本次运行已记录的模型用量汇总 */
  usage?: TokenUsage;
  /** 本次运行的唯一 ID */
  runId: string;
  /** Agent 产出的最终文本结论 */
  output: string;
  /** 完整的按发生时序排列的执行步骤列表 */
  steps: Step[];
  /** 所属多轮会话线程 ID */
  threadId: string;
}

/**
 * 持久化存储的完整运行链路实体 (TraceRun)
 */
export interface TraceRun extends RunResult {
  /** 执行本次运行的 Agent 名称 */
  agent: string;
  /** 调用方传入的初始入参 */
  input: unknown;
  /** 记录创建时间（ISO 字符串） */
  createdAt: string;
  /** 最后更新时间（ISO 字符串） */
  updatedAt: string;
}

/**
 * 运行时旁路事件 (RuntimeEvent)
 * 用于在流式接口 (SSE) 中向客户端实时推送状态：
 * - delta: 字符或词级别的内容流式增量
 * - step: 步骤完成事件（通知客户端当前处于哪个 plan/tool/final 阶段）
 */
export type RuntimeEvent =
  | { type: 'delta'; content: string }
  | { type: 'step'; step: Step };

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
  /** 由模型供应商返回的实际 token 用量 */
  usage?: TokenUsage;
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

/**
 * 文本向量化提供者契约 (EmbeddingProvider)
 *
 * 【统一向量化协议】
 * 支持批量输入文本，返回相同数量和顺序的高维向量。
 */
export interface EmbeddingProvider {
  /**
   * 将一组文本批量计算为向量
   *
   * @param texts 待向量化的文本数组
   * @returns 对应文本的高维向量浮点数数组列表 (number[][])
   */
  embed(texts: string[]): Promise<number[][]>;
}

export type PlanActionType = PlanAction['type'];
export type ExecuteError = NonNullable<ExecutionResult['error']>;
export type ExecuteResult = ExecutionResult;
export type AgentStreamEvent = RuntimeEvent;
