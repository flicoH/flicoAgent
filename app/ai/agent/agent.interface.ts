const AGENT_LOOP_MODES = ['react', 'plan-and-execute', 'reflection'] as const;

export type AgentLoopMode = typeof AGENT_LOOP_MODES[number];

export function isAgentLoopMode(value: unknown): value is AgentLoopMode {
  return AGENT_LOOP_MODES.some(mode => mode === value);
}

/**
 * Agent 声明契约 (AgentDefinition)
 *
 * 【无状态与纯声明设计原则】
 * 在 elpis 框架架构中，Agent 仅作为编排所需资源的纯元数据描述，
 * 绝不承载任何具体的执行逻辑、状态或业务代码。
 *
 * 具体的编排执行统一由 `OrchestratorService` 与 `PlannerService` 驱动，
 * 执行能力统一由 `Skill`（业务层）和 `Tool`（通用工具层）提供。
 */
export interface AgentDefinition {
  /** Agent 循环策略，默认 react。 */
  mode?: AgentLoopMode;

  /** reflection 允许的最大修订次数，默认 1。 */
  maxReflectionRevisions?: number;

  /**
   * Agent 的唯一注册名称
   * 用于客户端请求（如 POST /api/ai/agent/run）时识别和定位 Agent，禁止重名
   */
  name: string;

  /**
   * Agent 允许调用的 Skill（业务技能）名称列表
   * 仅在此白名单中的 Skill 会转换为工具描述并注入到该 Agent 的提示词/调用上下文
   */
  skills: string[];

  /**
   * Agent 允许调用的 Tool（通用工具）名称列表
   * 仅在此白名单中的 Tool 会注册到本次 Agent 运行环境中（如 retrieve 等）
   */
  tools: string[];

  /**
   * 直接内联的 System Prompt（系统提示词）
   * 若同时指定了 promptFile，Scanner 解析后会将外部提示词载入并覆盖此字段
   */
  prompt?: string;

  /**
   * 外部提示词模块路径
   * 支持相对于当前 `*.agent.js` 所在文件的相对路径，该文件需以 default export 导出一个 string
   */
  promptFile?: string;

  /**
   * 覆盖默认使用的模型注册名
   * 对应 `ai.llm.models` 配置中的模型 key；未指定时默认使用全局 `ai.llm.default`
   */
  model?: string;

  /**
   * 当前 Agent 优先使用的备用模型注册名链（按顺序切备）
   * 在主模型发生 429/5xx/超时/网络故障或熔断时优先于模型/全局 fallbacks 生效
   */
  fallbacks?: string[];

  /** 覆盖模型采样温度 */
  temperature?: number;

  /** 覆盖单次生成最大输出 token 数 */
  maxTokens?: number;

  /** 覆盖核采样概率阈值 (0, 1] */
  topP?: number;

  /** 覆盖单次模型调用超时时间（毫秒） */
  timeoutMs?: number;

  /** timeoutMs 的别名 */
  timeout?: number;

  /**
   * 结构化输出 JSON Schema 约束。
   * 声明后框架会在提示词注入结构要求、使用 ajv 校验最终输出 JSON，
   * 并在格式不合法时触发最多 maxOutputRetries 次自动纠错重试，成功时返回 structuredOutput。
   */
  outputSchema?: Record<string, unknown>;

  /** 结构化输出校验失败时的最大自动纠错重试次数，默认 2（设为 0 表示仅校验不重试）。 */
  maxOutputRetries?: number;

  /** 当前 Agent 可直接委派的 Agent 注册名。 */
  delegates?: string[];

  /** 仅允许经父 Agent 委派运行。 */
  delegationOnly?: boolean;
}
