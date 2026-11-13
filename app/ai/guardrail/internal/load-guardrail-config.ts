import { ConfigService } from '../../../config/config.service';
import { GuardrailRuleSet } from '../guardrail.interface';

/**
 * 从全局统一配置服务 (ConfigService) 解析安全护栏规则配置
 *
 * 【无状态纪律】
 * 规则完全由 demo 通过 config 中的 ai.guardrail (或 ai.guardrail.rules) 注入；
 * 严禁读取本地 guardrail.config.js 或 guardrail.rules.js 文件。
 *
 * @param config 全局配置服务
 * @returns 标准化的 GuardrailRuleSet 对象
 */
export function resolveGuardrailRuleSet(config: ConfigService): GuardrailRuleSet {
  const guardrailConfig = config.get<any>('ai.guardrail');
  if (!guardrailConfig || typeof guardrailConfig !== 'object') {
    return {
      blockedKeywords: [],
      blockedPatterns: [],
    };
  }

  // 兼容直接配置在 ai.guardrail 或 ai.guardrail.rules 下的形式
  const rawRules = guardrailConfig.rules && typeof guardrailConfig.rules === 'object'
    ? guardrailConfig.rules
    : guardrailConfig;

  const extractStringArray = (value: unknown): string[] => {
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    }
    if (typeof value === 'string' && value.trim()) {
      return [value.trim()];
    }
    return [];
  };

  const blockedKeywords = [
    ...extractStringArray(rawRules.blockedKeywords),
    ...extractStringArray(guardrailConfig.blockedKeywords),
  ];

  const blockedPatterns = [
    ...extractStringArray(rawRules.blockedPatterns),
    ...extractStringArray(guardrailConfig.blockedPatterns),
  ];

  // 数组去重
  return {
    blockedKeywords: Array.from(new Set(blockedKeywords)),
    blockedPatterns: Array.from(new Set(blockedPatterns)),
  };
}
