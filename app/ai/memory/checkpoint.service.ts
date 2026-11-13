import { Inject, Injectable } from '@nestjs/common';
import { SerialByKey } from '../../common/async/serial-by-key';
import { MEMORY_STORE, MemoryStore, ThreadCheckpoint } from '../store/store.interface';

/**
 * 检查点服务 (CheckpointService)
 *
 * 【会话检查点读写管理】
 * 统一承接 Thread 会话快照的读取与持久化操作：
 * 1. 经由注入的抽象契约 MEMORY_STORE (FileMemoryStore) 操作底层文件；
 * 2. 纪律：只持久化多轮对话 turns（user 提问与 assistant 最终回答），严格不存中间 execution steps。
 */
@Injectable()
export class CheckpointService {
  private readonly turns = new SerialByKey();
  constructor(
    @Inject(MEMORY_STORE)
    private readonly store: MemoryStore,
  ) {}

  /** 串行整个会话轮次，使下一次规划能读到上一轮已提交的上下文。 */
  runTurn<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    if (this.store.runTurn) return this.store.runTurn(threadId, work);
    return this.turns.run(threadId, work);
  }

  /**
   * 加载指定 threadId 的历史会话检查点
   *
   * @param threadId 会话线程唯一标识
   * @returns 匹配的 ThreadCheckpoint，不存在时返回 null
   */
  async load(threadId: string): Promise<ThreadCheckpoint | null> {
    if (!threadId || typeof threadId !== 'string') {
      return null;
    }
    const checkpoint = await this.store.load(threadId.trim());
    if (!checkpoint) {
      return null;
    }

    return this.normalizeCheckpoint(checkpoint);
  }

  /**
   * 持久化保存会话检查点
   * 仅持久化对话 turns，不存储任何 steps
   *
   * @param checkpoint 待保存的检查点
   */
  async save(checkpoint: ThreadCheckpoint): Promise<void> {
    if (!checkpoint || !checkpoint.threadId) {
      throw new Error('Checkpoint must contain a valid threadId');
    }

    await this.store.save(this.normalizeCheckpoint(checkpoint));
  }

  /** 读写共用清洗规则，旧数据或外部存储携带的执行步骤不会进入会话历史。 */
  private normalizeCheckpoint(checkpoint: ThreadCheckpoint): ThreadCheckpoint {
    const messages = Array.isArray(checkpoint.messages)
      ? checkpoint.messages
          .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          .map(m => ({ role: m.role, content: m.content }))
      : [];

    return {
      threadId: checkpoint.threadId,
      messages,
      updatedAt: checkpoint.updatedAt ?? Date.now(),
    };
  }

  /**
   * 删除指定会话线程的检查点
   *
   * @param threadId 会话线程唯一标识
   */
  async delete(threadId: string): Promise<void> {
    if (this.store.delete && threadId) {
      await this.store.delete(threadId.trim());
    }
  }
}
