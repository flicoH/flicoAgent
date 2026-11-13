import type { TokenUsage } from '../../contracts';

/** 仅接受模型实际报告的计数。总量缺省时由输入、输出相加。 */
export function normalizeTokenUsage(input: unknown, output: unknown, total?: unknown): TokenUsage | undefined {
  const isCount = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (!isCount(input) || !isCount(output)) return undefined;
  const totalTokens = total ?? input + output;
  if (!isCount(totalTokens)) return undefined;
  return { inputTokens: input, outputTokens: output, totalTokens };
}

/** 累加多轮调用的已报告用量。缺失的用量保留为未知。 */
export function addTokenUsage(left?: TokenUsage, right?: TokenUsage): TokenUsage | undefined {
  if (!left || !right) return left ?? right;
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}
