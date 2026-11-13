/**
 * 技能执行上下文 (SkillContext)
 *
 * 【设计说明】
 * 在运行时由框架构造并传递给 `SkillDefinition.execute` 方法。
 * 可用于在技能执行期间透传当前运行链路信息（如 runId、agent 名称、调用方身份、跟踪上下文等）。
 */
export interface SkillContext {
  [key: string]: unknown;
}

/**
 * 业务技能契约定义 (SkillDefinition)
 *
 * 【职责划分】
 * Skill 代表业务方自主声明和实现的业务能力（例如“查询项目列表”、“根据ID获取详情”等）。
 * 框架不硬编码任何具体业务语义，仅规范 Skill 的声明与执行契约：
 * 1. 提供名称与人类/模型可读的能力描述；
 * 2. 提供符合 JSON Schema 规范的输入参数约束；
 * 3. 实现无副作用或有业务语义的异步执行逻辑。
 */
export interface SkillDefinition {
  /**
   * 技能的唯一注册名称
   * 同时作为大模型 Function Calling (Tools) 中的函数名，禁止重名
   */
  name: string;

  /**
   * 技能的简明描述
   * 面向模型规划器与调用方，清晰说明此技能的作用、触发时机与预期结果
   */
  description: string;

  /**
   * 描述输入参数的 JSON Schema
   * 供大模型理解需要生成哪些参数结构，并在调用层进行 Schema 校验
   */
  inputSchema: unknown;

  /**
   * 执行该技能的核心业务逻辑
   *
   * @param input 模型传入并经过反序列化的参数对象
   * @param ctx 框架传递的执行上下文环境
   * @returns 业务执行结果（需为可序列化的 JSON 兼容值）
   */
  execute(input: unknown, ctx: SkillContext): Promise<unknown>;
}
