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
}
