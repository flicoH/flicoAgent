import { createHash } from 'node:crypto';
import type { LlmMessage } from '../../contracts';
import type { MemoryEntry } from '../../store/store.interface';

export const SCOPED_CHECKPOINT_PREFIX = 'agent-scope-';
export const SCOPED_CHECKPOINT_ID_PATTERN = /^agent-scope-[a-f0-9]{64}$/i;

const CJK_CHAR_PATTERN = /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;
const MESSAGE_OVERHEAD_TOKENS = 4;

export interface TokenBudgetTrimResult {
  kept: MemoryEntry[];
  dropped: MemoryEntry[];
  estimatedTokens: number;
}

/**
 * 计算按 scope 隔离的持久化检查点存储键
 */
export function computeScopedCheckpointId(scope: string | undefined, threadId: string): string {
  const clean = threadId.trim();
  return scope === undefined
    ? clean
    : SCOPED_CHECKPOINT_PREFIX + createHash('sha256').update(JSON.stringify([scope, clean])).digest('hex');
}

/**
 * 判断字符串是否命中内部作用域检查点键格式（防止无 scope 请求探测租户 hash 键）
 */
export function isScopedCheckpointKey(threadId: string): boolean {
  const normalized = decodeURIComponent(threadId).replace(/^\{|\}$/g, '').trim();
  return SCOPED_CHECKPOINT_ID_PATTERN.test(normalized);
}

/**
 * 零外部依赖的中英文混合 Token 估算器
 * - CJK / 全角字符按 ~0.8 token/字 估算
 * - 非 CJK 字符按 ~0.25 token/字符 估算
 */
export function estimateTextTokens(text: string): number {
  if (!text || typeof text !== 'string') {
    return 0;
  }
  let cjkCount = 0;
  let otherCount = 0;
  for (const char of text) {
    if (CJK_CHAR_PATTERN.test(char)) {
      cjkCount++;
    } else {
      otherCount++;
    }
  }
  return Math.max(1, Math.ceil(cjkCount * 0.8 + otherCount / 4));
}

export function estimateMessageTokens(message: { role?: string; content?: string | null }): number {
  const content = typeof message?.content === 'string' ? message.content : '';
  return MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(content);
}

export function estimateMessagesTokens(messages: ReadonlyArray<{ role?: string; content?: string | null }>): number {
  if (!Array.isArray(messages) || messages.length === 0) {
    return 0;
  }
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

/**
 * 按 Token 预算逆序裁剪历史消息，优先保留最新对话并避免孤立 assistant 开头。
 */
export function trimMessagesToTokenBudget(
  messages: MemoryEntry[],
  maxTokens: number,
  options: { minRecentMessages?: number } = {},
): TokenBudgetTrimResult {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { kept: [], dropped: [], estimatedTokens: 0 };
  }
  const budget = Math.max(1, Math.floor(maxTokens));
  const minRecent = Math.max(0, Math.floor(options.minRecentMessages ?? 1));

  let startIndex = messages.length;
  let accTokens = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = estimateMessageTokens(messages[i]);
    const keptCount = messages.length - i;
    if (accTokens + cost <= budget) {
      accTokens += cost;
      startIndex = i;
    } else if (keptCount <= minRecent && startIndex === messages.length) {
      // 当预算小于最新单条消息时，若允许保底保留则至少保留最新一条避免上下文完全归零
      accTokens += cost;
      startIndex = i;
      break;
    } else {
      break;
    }
  }

  let kept = messages.slice(startIndex);
  let dropped = messages.slice(0, startIndex);

  // 若裁剪后首条消息为孤立 assistant 且还有后续消息，将孤立 assistant 移出以保持对话以 user 开头
  if (kept.length > 1 && kept[0].role === 'assistant') {
    dropped = [...dropped, kept[0]];
    kept = kept.slice(1);
    accTokens = estimateMessagesTokens(kept);
  }

  return {
    kept,
    dropped,
    estimatedTokens: accTokens,
  };
}

export function buildSummarySystemMessage(summary: string): LlmMessage {
  return {
    role: 'system',
    content: `以下是本会话早期对话的压缩摘要（请严格遵守其中已确认的约束、偏好、实体信息与未完成事项）：\n${summary.trim()}`,
  };
}

export function buildSummarizationMessages(
  existingSummary: string | undefined,
  messagesToCompress: MemoryEntry[],
  maxSummaryChars: number,
): LlmMessage[] {
  const transcript = messagesToCompress
    .map(entry => `${entry.role === 'user' ? 'User' : 'Assistant'}: ${entry.content}`)
    .join('\n');

  const userParts: string[] = [];
  if (existingSummary && existingSummary.trim()) {
    userParts.push(`【已有历史摘要】\n${existingSummary.trim()}`);
  }
  userParts.push(`【待压缩的新增早期对话】\n${transcript}`);
  userParts.push(
    `请输出更新后的精简中文/原语言摘要（不超过 ${maxSummaryChars} 字符），严格保留：` +
    '1) 用户明确提出的约束条件、格式要求、禁止项与偏好；' +
    '2) 已确认的关键事实、编号/实体名称与决策结论；' +
    '3) 尚未完成的待办或后续目标。' +
    '只输出摘要正文，不要添加额外寒暄。',
  );

  return [
    {
      role: 'system',
      content: '你是一个高保真的对话记忆压缩器。你的职责是将早期多轮对话增量合并为紧凑摘要，绝对不能丢失用户的硬性约束、偏好和关键标识符。',
    },
    {
      role: 'user',
      content: userParts.join('\n\n'),
    },
  ];
}

export function deriveThreadTitle(userText: string, maxLength = 80): string | undefined {
  if (typeof userText !== 'string') {
    return undefined;
  }
  const normalized = userText.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}
