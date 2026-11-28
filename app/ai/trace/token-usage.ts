import type { Step, TokenUsage } from '../contracts';

function isNonNegativeSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isTokenUsage(usage: Partial<TokenUsage> | null | undefined): usage is TokenUsage {
  if (!usage || typeof usage !== 'object') {
    return false;
  }
  if (!isNonNegativeSafeInt(usage.totalTokens)) {
    return false;
  }
  if (usage.inputTokens !== undefined && !isNonNegativeSafeInt(usage.inputTokens)) {
    return false;
  }
  if (usage.outputTokens !== undefined && !isNonNegativeSafeInt(usage.outputTokens)) {
    return false;
  }
  return true;
}

/** 仅累加有效的上报值。没有有效数据时返回 undefined，实际零用量仍保留为 0。 */
export function summarizeTokenUsage(steps: readonly Step[]): TokenUsage | undefined {
  let total: TokenUsage | undefined;
  for (const { usage } of steps) {
    if (!isTokenUsage(usage)) {
      continue;
    }
    total ??= { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    total.inputTokens += usage.inputTokens ?? 0;
    total.outputTokens += usage.outputTokens ?? 0;
    total.totalTokens += usage.totalTokens;
  }
  return total;
}
