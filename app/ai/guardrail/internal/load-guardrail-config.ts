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

  const extractPatternArray = (value: unknown): Array<string | RegExp> => {
    const items = Array.isArray(value) ? value : [value];
    const results: Array<string | RegExp> = [];
    for (const item of items) {
      if (item instanceof RegExp) {
        results.push(item);
      } else if (typeof item === 'string' && item.trim().length > 0) {
        results.push(item.trim());
      }
    }
    return results;
  };

  const blockedKeywords = [
    ...extractStringArray(rawRules.blockedKeywords),
    ...extractStringArray(guardrailConfig.blockedKeywords),
  ];

  const blockedPatterns = [
    ...extractPatternArray(rawRules.blockedPatterns),
    ...extractPatternArray(guardrailConfig.blockedPatterns),
  ];

  // 数组去重
  const seenPatterns = new Set<string>();
  const uniquePatterns = blockedPatterns.filter(pattern => {
    const key = pattern instanceof RegExp ? `/${pattern.source}/${pattern.flags}` : `s:${pattern}`;
    if (seenPatterns.has(key)) return false;
    seenPatterns.add(key);
    return true;
  });
  return {
    blockedKeywords: Array.from(new Set(blockedKeywords)),
    blockedPatterns: uniquePatterns,
  };
}
