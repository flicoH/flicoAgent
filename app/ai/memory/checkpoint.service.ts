import { Inject, Injectable } from '@nestjs/common';
import {
  MEMORY_STORE,
  MemoryListQuery,
  MemoryStore,
  ThreadCheckpoint,
} from '../store/store.interface';

function sanitizeCheckpoint(checkpoint: ThreadCheckpoint): ThreadCheckpoint {
  const cleanMessages = Array.isArray(checkpoint.messages)
    ? checkpoint.messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map(m => ({ role: m.role, content: m.content }))
    : [];

  return {
    threadId: checkpoint.threadId,
    ...(typeof checkpoint.publicThreadId === 'string' && checkpoint.publicThreadId.trim()
      ? { publicThreadId: checkpoint.publicThreadId.trim() } : {}),
    ...(typeof checkpoint.scope === 'string' ? { scope: checkpoint.scope } : {}),
    ...(typeof checkpoint.title === 'string' && checkpoint.title.trim()
      ? { title: checkpoint.title.trim() } : {}),
    ...(typeof checkpoint.agent === 'string' && checkpoint.agent.trim()
      ? { agent: checkpoint.agent.trim() } : {}),
    messages: cleanMessages,
    ...(typeof checkpoint.summary === 'string' && checkpoint.summary.trim()
      ? { summary: checkpoint.summary.trim() } : {}),
    ...(typeof checkpoint.summarizedCount === 'number' && Number.isSafeInteger(checkpoint.summarizedCount) && checkpoint.summarizedCount >= 0
      ? { summarizedCount: checkpoint.summarizedCount } : {}),
    ...(typeof checkpoint.createdAt === 'number' && Number.isFinite(checkpoint.createdAt)
      ? { createdAt: checkpoint.createdAt } : {}),
    updatedAt: checkpoint.updatedAt ?? Date.now(),
  };
}

/**
 * 检查点服务 (CheckpointService)
 *
 * 【会话检查点读写与并发串行管理】
 * 1. 经由注入的抽象契约 MEMORY_STORE 操作底层持久化；
 * 2. 只持久化多轮对话 turns 与可选线程摘要/元数据，绝不渗入中间 execution steps；
 * 3. 提供 runTurn(threadId, task) 串行化同一线程的并发轮次：优先委托 MemoryStore.runTurn（支持跨实例锁），
 *    否则使用进程内按 threadId 链式队列；
 * 4. 提供 list(query) 按 scope 分页列举线程检查点。
 */
@Injectable()
export class CheckpointService {
  private readonly turnQueues = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(MEMORY_STORE)
    private readonly store: MemoryStore,
  ) {}

  async runTurn<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const key = threadId.trim();
    if (!key) {
      return task();
    }
    if (typeof this.store.runTurn === 'function') {
      return this.store.runTurn(key, task);
    }

    const previous = this.turnQueues.get(key) ?? Promise.resolve();
    const next = previous.then(task);
    const tracked = next.catch(() => undefined).finally(() => {
      if (this.turnQueues.get(key) === tracked) {
        this.turnQueues.delete(key);
      }
    });
    this.turnQueues.set(key, tracked);
    return next;
  }

  async load(threadId: string): Promise<ThreadCheckpoint | null> {
    if (!threadId || typeof threadId !== 'string') {
      return null;
    }
    const checkpoint = await this.store.load(threadId.trim());
    if (!checkpoint) {
      return null;
    }
    return sanitizeCheckpoint(checkpoint);
  }

  async save(checkpoint: ThreadCheckpoint): Promise<void> {
    if (!checkpoint || !checkpoint.threadId) {
      throw new Error('Checkpoint must contain a valid threadId');
    }
    await this.store.save(sanitizeCheckpoint(checkpoint));
  }

  async list(query: MemoryListQuery): Promise<ThreadCheckpoint[]> {
    if (typeof this.store.list !== 'function') {
      throw new Error('Configured MemoryStore does not support listing threads');
    }
    const rows = await this.store.list(query);
    return rows.map(sanitizeCheckpoint);
  }

  async delete(threadId: string): Promise<void> {
    if (this.store.delete && threadId) {
      await this.store.delete(threadId.trim());
    }
  }
}
