import { Inject, Injectable } from '@nestjs/common';
import { MEMORY_STORE, MemoryStore, ThreadCheckpoint } from '../store/store.interface';

/**
 * 检查点服务 (CheckpointService)
 *
 * 【会话检查点读写与并发串行管理】
 * 1. 经由注入的抽象契约 MEMORY_STORE 操作底层持久化；
 * 2. 只持久化多轮对话 turns（user 与 assistant），绝不渗入中间 execution steps；
 * 3. 提供 runTurn(threadId, task) 串行化同一线程的并发轮次：优先委托 MemoryStore.runTurn（支持跨实例锁），
 *    否则使用进程内按 threadId 链式队列。
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

    const validMessages = Array.isArray(checkpoint.messages)
      ? checkpoint.messages
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map(m => ({ role: m.role, content: m.content }))
      : [];

    return {
      threadId: checkpoint.threadId,
      messages: validMessages,
      updatedAt: checkpoint.updatedAt ?? Date.now(),
    };
  }

  async save(checkpoint: ThreadCheckpoint): Promise<void> {
    if (!checkpoint || !checkpoint.threadId) {
      throw new Error('Checkpoint must contain a valid threadId');
    }

    const cleanMessages = Array.isArray(checkpoint.messages)
      ? checkpoint.messages
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map(m => ({ role: m.role, content: m.content }))
      : [];

    await this.store.save({
      threadId: checkpoint.threadId,
      messages: cleanMessages,
      updatedAt: checkpoint.updatedAt ?? Date.now(),
    });
  }

  async delete(threadId: string): Promise<void> {
    if (this.store.delete && threadId) {
      await this.store.delete(threadId.trim());
    }
  }
}
