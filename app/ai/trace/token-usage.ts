import type { Step, TokenUsage } from '../contracts';

export function isTokenUsage(usage: TokenUsage | null | undefined): usage is TokenUsage {
  return !!usage && [usage.inputTokens, usage.outputTokens, usage.totalTokens]
    .every((count) => Number.isSafeInteger(count) && count >= 0);
}

/** 仅累加有效的上报值。没有有效数据时返回 undefined，实际零用量仍保留为 0。 */
export function summarizeTokenUsage(steps: readonly Step[]): TokenUsage | undefined {
  let total: TokenUsage | undefined;
  for (const { usage } of steps) {
    if (!isTokenUsage(usage)) {
      continue;
    }
    total ??= { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.totalTokens += usage.totalTokens;
  }
  return total;
}
