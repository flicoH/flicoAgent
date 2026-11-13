import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '../../config/config.service';
import { LlmMessage } from '../llm/llm.interface';
import { MemoryEntry, ThreadCheckpoint } from '../store/store.interface';
import { resolveMemoryMaxTurns, resolveThreadEnabled } from './internal/load-memory-config';

/**
 * 会话线程服务 (ThreadService)
 *
 * 【多轮上下文与滑动窗口管理】
 * 1. threadId 维护：支持创建新线程 (createThread) 与安全检查保证 (ensureThread)；
 * 2. 消息构建：从 Checkpoint 提取 user/assistant 对话 turns 并转换为 LlmMessage；
 * 3. 滑动窗口截断：按 maxTurns（消息条数，非轮数）进行滑动截断（messages.slice(-N)）；
 * 4. 轮次追加：将当前轮的提问与最终回答追加至历史并更新时间戳；
 * 5. 开关状态：读取全局配置判定是否启用多轮会话线程（isThreadEnabled）。
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
   *
   * @param threadId 可选传入的已有线程 ID
   * @returns 保证非空的 threadId
   */
  ensureThread(threadId?: string): string {
    if (typeof threadId === 'string' && threadId.trim().length > 0) {
      return threadId.trim();
    }
    return this.createThread();
  }

  /**
   * 从 ThreadCheckpoint 中提取纯对话消息作为大模型上下文 (LlmMessage[])
   * 仅取 user 与 assistant 的 turns，剔除任何中间状态
   *
   * @param checkpoint 线程检查点
   * @returns 适合送入大模型的历史上下文消息列表
   */
  buildContextMessages(checkpoint: ThreadCheckpoint | null | undefined): LlmMessage[] {
    if (!checkpoint || !Array.isArray(checkpoint.messages) || checkpoint.messages.length === 0) {
      return [];
    }

    const result: LlmMessage[] = [];
    for (const msg of checkpoint.messages) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        result.push({
          role: msg.role,
          content: msg.content,
        });
      }
    }
    return result;
  }

  /**
   * 滑动窗口截断
   * 截取最近 N 条消息记录：messages.slice(-N)。
   *
   * 【截断规则】
   * 1. N 为单条消息条数（一条 user 或一条 assistant 各计 1 条）；
   * 2. N 优先使用入参 maxTurns，未传时严格读取配置 resolveMemoryMaxTurns (默认 20)；
   * 3. 消息不足 N 条时原样返回；禁止缺省时全量放行。
   *
   * @param messages 历史消息条目列表
   * @param maxTurns 可选窗口大小上限
   * @returns 截断后的消息条目列表
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
   * 将当前轮的用户提问与最终回答追加到检查点中
   *
   * @param checkpoint 现有检查点（若为 null/undefined 则自动新建）
   * @param user 用户提问文本
   * @param assistant 最终答复文本
   * @param fallbackThreadId 当 checkpoint 为空时指定的会话线程 ID（缺省则自动生成）
   * @returns 更新后的 ThreadCheckpoint
   */
  appendTurn(
    checkpoint: ThreadCheckpoint | null | undefined,
    user: string,
    assistant: string,
    fallbackThreadId?: string,
  ): ThreadCheckpoint {
    const threadId = checkpoint?.threadId ?? fallbackThreadId ?? this.createThread();
    const existing = Array.isArray(checkpoint?.messages) ? checkpoint.messages : [];

    const newMessages: MemoryEntry[] = [
      ...existing,
      { role: 'user', content: user },
      { role: 'assistant', content: assistant },
    ];

    return {
      threadId,
      messages: newMessages,
      updatedAt: Date.now(),
    };
  }
}
