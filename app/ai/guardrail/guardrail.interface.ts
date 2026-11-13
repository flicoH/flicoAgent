/**
 * 安全护栏规则配置契约 (GuardrailRuleSet)
 */
export interface GuardrailRuleSet {
  /** 违禁关键词黑名单，只要输入中包含任一关键词即判定违规拦截 */
  blockedKeywords?: string[];
  /** 违禁正则表达式模式黑名单，只要输入匹配任一模式即判定违规拦截 */
  blockedPatterns?: string[];
}

/**
 * 安全护栏检测结果契约 (GuardrailCheckResult)
 */
export interface GuardrailCheckResult {
  /** 是否安全通过：true 表示安全无违规，false 表示被拦截 */
  safe: boolean;
  /** 被拦截时的拒绝原因或触发规则描述 */
  reason?: string;
}
