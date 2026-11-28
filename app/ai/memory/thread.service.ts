import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '../../config/config.service';
import type { LlmMessage, ThreadDetail, ThreadSummary } from '../contracts';
import type { MemoryEntry, ThreadCheckpoint } from '../store/store.interface';
import {
  resolveMemoryMaxContextTokens,
  resolveMemoryMaxTurns,
  resolveMemorySummarizationOptions,
  resolveThreadEnabled,
} from './internal/load-memory-config';
import {
  buildSummarizationMessages,
  buildSummarySystemMessage,
  deriveThreadTitle,
  estimateMessageTokens,
  estimateMessagesTokens,
  trimMessagesToTokenBudget,
} from './internal/token-budget';

export type MemorySummarizer = (
  messages: LlmMessage[],
  options: { model?: string },
) => Promise<string>;

export interface AppendTurnMetadata {
  publicThreadId?: string;
  scope?: string;
  agent?: string;
  title?: string;
}

/**
 * 会话线程服务 (ThreadService)
 *
 * 【多轮上下文、Token 预算与摘要压缩管理】
 * 1. threadId 维护：支持创建新线程 (createThread) 与安全检查保证 (ensureThread)；
 * 2. 消息构建：从 Checkpoint 提取摘要系统消息与 user/assistant 对话 turns，并按可选 maxContextTokens 预算裁剪；
 * 3. 滑动窗口截断：按 maxTurns（消息条数，非轮数）进行滑动截断（messages.slice(-N)）；
 * 4. 自动摘要压缩：超长会话将较早对话增量压缩为 summary，保留早期约束而不丢上下文；
 * 5. 视图脱敏：提供 toThreadSummary / toThreadDetail 对外安全展示线程元数据与历史。
 */
@Injectable()
export class ThreadService {
  constructor(private readonly config: ConfigService) {}

  /**
   * 当前运行环境是否启用多轮会话上下文保持
   */
  isThreadEnabled(): boolean {
    return resolveThreadEnabled(this.config);
  }

  /**
   * 创建全新的会话线程 ID (UUID)
   */
  createThread(): string {
    return randomUUID();
  }

  /**
   * 确保存在合法的 threadId
   * 有传入则安全返回原值，无传入则自动创建新线程 ID（禁止覆盖已有 ID）
   */
  ensureThread(threadId?: string): string {
    if (typeof threadId === 'string' && threadId.trim().length > 0) {
      return threadId.trim();
    }
    return this.createThread();
  }

  /**
   * 从 ThreadCheckpoint 中提取模型上下文 (LlmMessage[])
   * - 若存在历史摘要 checkpoint.summary，前置注入为系统摘要消息；
   * - 仅取 user 与 assistant 的 turns，剔除任何中间状态；
   * - 若配置了 maxContextTokens，按预算裁剪近期对话消息（先扣除摘要所占 Token）。
   */
  buildContextMessages(
    checkpoint: ThreadCheckpoint | null | undefined,
    options?: { maxContextTokens?: number },
  ): LlmMessage[] {
    if (!checkpoint) {
      return [];
    }

    const summaryText = typeof checkpoint.summary === 'string' ? checkpoint.summary.trim() : '';
    const summaryMessage = summaryText ? buildSummarySystemMessage(summaryText) : undefined;

    const rawMessages: MemoryEntry[] = Array.isArray(checkpoint.messages)
      ? checkpoint.messages
        .filter(msg => msg && (msg.role === 'user' || msg.role === 'assistant') && typeof msg.content === 'string')
        .map(msg => ({ role: msg.role, content: msg.content }))
      : [];

    if (!summaryMessage && rawMessages.length === 0) {
      return [];
    }

    const maxContextTokens = options?.maxContextTokens ?? resolveMemoryMaxContextTokens(this.config);
    let selectedMessages = rawMessages;

    if (maxContextTokens !== undefined && rawMessages.length > 0) {
      const summaryTokens = summaryMessage ? estimateMessageTokens(summaryMessage) : 0;
      const remainingBudget = Math.max(1, maxContextTokens - summaryTokens);
      selectedMessages = trimMessagesToTokenBudget(rawMessages, remainingBudget).kept;
    }

    const result: LlmMessage[] = [];
    if (summaryMessage) {
      result.push(summaryMessage);
    }
    for (const msg of selectedMessages) {
      result.push({
        role: msg.role,
        content: msg.content,
      });
    }
    return result;
  }

  /**
   * 滑动窗口截断：截取最近 N 条消息记录 messages.slice(-N)
   */
  truncate(messages: MemoryEntry[], maxTurns?: number): MemoryEntry[] {
    if (!Array.isArray(messages) || messages.length === 0) {
      return [];
    }

    const n = (typeof maxTurns === 'number' && Number.isFinite(maxTurns) && maxTurns > 0)
      ? Math.floor(maxTurns)
      : resolveMemoryMaxTurns(this.config);

    if (messages.length <= n) {
      return [...messages];
    }

    return messages.slice(-n);
  }

  /**
   * 将当前轮的用户提问与最终回答追加到检查点中，同时保留并更新摘要与元数据
   */
  appendTurn(
    checkpoint: ThreadCheckpoint | null | undefined,
    user: string,
    assistant: string,
    fallbackThreadId?: string,
    metadata?: AppendTurnMetadata,
  ): ThreadCheckpoint {
    const threadId = checkpoint?.threadId ?? fallbackThreadId ?? this.createThread();
    const existing = Array.isArray(checkpoint?.messages) ? checkpoint.messages : [];
    const now = Date.now();

    const newMessages: MemoryEntry[] = [
      ...existing,
      { role: 'user', content: user },
      { role: 'assistant', content: assistant },
    ];

    const publicThreadId = checkpoint?.publicThreadId ?? metadata?.publicThreadId;
    const scope = checkpoint?.scope ?? metadata?.scope;
    const agent = metadata?.agent ?? checkpoint?.agent;
    const title = checkpoint?.title ?? metadata?.title ?? (metadata ? deriveThreadTitle(user) : undefined);
    const createdAt = checkpoint?.createdAt ?? (metadata ? now : undefined);

    return {
      threadId,
      ...(publicThreadId !== undefined ? { publicThreadId } : {}),
      ...(scope !== undefined ? { scope } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(agent !== undefined ? { agent } : {}),
      messages: newMessages,
      ...(checkpoint?.summary !== undefined ? { summary: checkpoint.summary } : {}),
      ...(checkpoint?.summarizedCount !== undefined ? { summarizedCount: checkpoint.summarizedCount } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
      updatedAt: now,
    };
  }

  /**
   * 对超长检查点执行自动历史摘要压缩与窗口收敛。
   * - 若未开启 summarization，仅按 maxTurns 截断；
   * - 若开启 summarization 且消息数超过 keepRecentMessages，且触发 maxTurns 或 triggerTokens 阈值，
   *   调用 summarizer 增量合并较早对话为 summary，保留最近 keepRecentMessages 条原文；
   * - 若摘要调用异常或返回空文本，优雅降级为标准 truncate，不破坏主流程。
   */
  async compressCheckpoint(
    checkpoint: ThreadCheckpoint,
    summarizer?: MemorySummarizer,
  ): Promise<ThreadCheckpoint> {
    const maxTurns = resolveMemoryMaxTurns(this.config);
    const summarization = resolveMemorySummarizationOptions(this.config);
    const messages = Array.isArray(checkpoint.messages) ? [...checkpoint.messages] : [];

    const estimatedTokens = estimateMessagesTokens(messages)
      + (checkpoint.summary ? estimateMessageTokens(buildSummarySystemMessage(checkpoint.summary)) : 0);

    const shouldSummarize = summarization.enabled
      && typeof summarizer === 'function'
      && messages.length > summarization.keepRecentMessages
      && (messages.length > maxTurns || estimatedTokens > summarization.triggerTokens);

    if (!shouldSummarize) {
      return {
        ...checkpoint,
        messages: this.truncate(messages, maxTurns),
      };
    }

    const splitAt = messages.length - summarization.keepRecentMessages;
    const toCompress = messages.slice(0, splitAt);
    const keptRecent = messages.slice(splitAt);

    try {
      const promptMessages = buildSummarizationMessages(
        checkpoint.summary,
        toCompress,
        summarization.maxSummaryChars,
      );
      const rawSummary = await summarizer(promptMessages, { model: summarization.model });
      const cleaned = typeof rawSummary === 'string' ? rawSummary.trim() : '';
      if (!cleaned) {
        return {
          ...checkpoint,
          messages: this.truncate(messages, maxTurns),
        };
      }
      const boundedSummary = cleaned.length > summarization.maxSummaryChars
        ? cleaned.slice(0, summarization.maxSummaryChars)
        : cleaned;

      return {
        ...checkpoint,
        messages: this.truncate(keptRecent, maxTurns),
        summary: boundedSummary,
        summarizedCount: (checkpoint.summarizedCount ?? 0) + toCompress.length,
      };
    } catch {
      // 摘要模型调用失败时优雅降级，避免中断已完成的 Agent 主运行
      return {
        ...checkpoint,
        messages: this.truncate(messages, maxTurns),
      };
    }
  }

  /**
   * 估算检查点当前上下文（摘要 + 近期消息）的 Token 消耗
   */
  estimateCheckpointTokens(checkpoint: ThreadCheckpoint): number {
    const summaryTokens = checkpoint.summary
      ? estimateMessageTokens(buildSummarySystemMessage(checkpoint.summary))
      : 0;
    const msgTokens = Array.isArray(checkpoint.messages)
      ? estimateMessagesTokens(checkpoint.messages)
      : 0;
    return summaryTokens + msgTokens;
  }

  /**
   * 构造对外脱敏的线程摘要视图（绝不暴露内部 scope 或 hash 存储键）
   */
  toThreadSummary(checkpoint: ThreadCheckpoint): ThreadSummary {
    const messages = Array.isArray(checkpoint.messages) ? checkpoint.messages : [];
    const summary = typeof checkpoint.summary === 'string' && checkpoint.summary.trim()
      ? checkpoint.summary.trim()
      : undefined;

    return {
      threadId: checkpoint.publicThreadId ?? checkpoint.threadId,
      ...(checkpoint.title ? { title: checkpoint.title } : {}),
      ...(checkpoint.agent ? { agent: checkpoint.agent } : {}),
      messageCount: messages.length,
      summarizedCount: checkpoint.summarizedCount ?? 0,
      hasSummary: Boolean(summary),
      estimatedTokens: this.estimateCheckpointTokens(checkpoint),
      ...(checkpoint.createdAt !== undefined ? { createdAt: checkpoint.createdAt } : {}),
      updatedAt: checkpoint.updatedAt,
    };
  }

  /**
   * 构造对外脱敏的线程详情视图
   */
  toThreadDetail(checkpoint: ThreadCheckpoint): ThreadDetail {
    const summaryText = typeof checkpoint.summary === 'string' && checkpoint.summary.trim()
      ? checkpoint.summary.trim()
      : undefined;
    const messages = Array.isArray(checkpoint.messages)
      ? checkpoint.messages.map(m => ({ role: m.role, content: m.content }))
      : [];

    return {
      ...this.toThreadSummary(checkpoint),
      ...(summaryText ? { summary: summaryText } : {}),
      messages,
    };
  }
}
