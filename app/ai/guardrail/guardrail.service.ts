import { Injectable } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import { GuardrailCheckResult } from './guardrail.interface';
import { resolveGuardrailRuleSet } from './internal/load-guardrail-config';

/**
 * 安全护栏守卫服务 (GuardrailService)
 *
 * 【架构职责】
 * 负责输入、输出与执行过程的安全约束与合规审计：
 * 1. 输入护栏：敏感词过滤、Prompt 注入防御、高危命令拦截；
 * 2. 匹配由业务 demo 配置注入的 blockedKeywords 与 blockedPatterns；
 * 3. 框架本身不 hardcode 任何违禁词表，保持纯净通用运行时。
 */
@Injectable()
export class GuardrailService {
  constructor(private readonly config: ConfigService) {}

  /**
   * 对输入内容进行安全检测与合规校验
   *
   * @param input 用户输入文本
   * @returns 检测结果 { safe: boolean, reason?: string }
   */
  check(input: string): GuardrailCheckResult {
    if (typeof input !== 'string') {
      return { safe: true };
    }

    const { blockedKeywords = [], blockedPatterns = [] } = resolveGuardrailRuleSet(this.config);

    // 1. 匹配关键词黑名单 blockedKeywords
    for (const keyword of blockedKeywords) {
      if (keyword && input.includes(keyword)) {
        return {
          safe: false,
          reason: `触发安全规则：包含违禁关键词「${keyword}」`,
        };
      }
    }

    // 2. 匹配正则表达式模式黑名单 blockedPatterns
    for (const pattern of blockedPatterns) {
      if (pattern) {
        try {
          const regex = pattern instanceof RegExp
            ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))
            : new RegExp(pattern, 'i');
          if (regex.test(input)) {
            return {
              safe: false,
              reason: `触发安全规则：匹配违禁模式「${pattern instanceof RegExp ? pattern.source : pattern}」`,
            };
          }
        } catch {
          // 忽略非法正则表达式，保障主流程高可用
        }
      }
    }

    return { safe: true };
  }
}
