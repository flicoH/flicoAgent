import type Knex from 'knex';
import { createHash } from 'node:crypto';
import type { MemoryListQuery, MemoryStore, ThreadCheckpoint } from '../store.interface';

const memoryTable = 'flico_ai_memory';

interface MemoryRow {
  namespace_key: string;
  thread_key: string;
  thread_id: string;
  updated_at: number;
  payload: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class MysqlMemoryStore implements MemoryStore {
  private readonly namespaceKey: string;
  private readonly lockTimeoutSeconds: number;

  constructor(
    private readonly database: Knex,
    namespace = 'default',
    options: { lockTimeoutSeconds?: number } = {},
  ) {
    this.namespaceKey = sha256(namespace);
    this.lockTimeoutSeconds = Math.max(1, Math.floor(options.lockTimeoutSeconds ?? 30));
  }

  async save(checkpoint: ThreadCheckpoint): Promise<void> {
    if (!checkpoint || typeof checkpoint.threadId !== 'string' || !checkpoint.threadId.trim()) {
      throw new Error('ThreadCheckpoint must have a valid string threadId');
    }
    const threadId = checkpoint.threadId.trim();
    const row: MemoryRow = {
      namespace_key: this.namespaceKey,
      thread_key: sha256(threadId),
      thread_id: threadId,
      updated_at: checkpoint.updatedAt ?? Date.now(),
      payload: JSON.stringify(checkpoint),
    };

    await this.database.raw(
      `INSERT INTO ?? (namespace_key, thread_key, thread_id, updated_at, payload)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         updated_at = VALUES(updated_at),
         payload = VALUES(payload)`,
      [
        memoryTable,
        row.namespace_key,
        row.thread_key,
        row.thread_id,
        row.updated_at,
        row.payload,
      ],
    );
  }

  async load(threadId: string): Promise<ThreadCheckpoint | null> {
    const cleanId = typeof threadId === 'string' ? threadId.trim() : '';
    if (!cleanId) return null;
    const row = await this.database<MemoryRow>(memoryTable)
      .where('namespace_key', this.namespaceKey)
      .where('thread_key', sha256(cleanId))
      .first('payload');
    return row ? (JSON.parse(row.payload) as ThreadCheckpoint) : null;
  }

  async list(query: MemoryListQuery): Promise<ThreadCheckpoint[]> {
    const offset = Math.max(0, Math.floor(query.offset || 0));
    const limit = Math.max(0, Math.floor(query.limit || 0));
    if (limit === 0) return [];

    const rows = await this.database<MemoryRow>(memoryTable)
      .where('namespace_key', this.namespaceKey)
      .orderBy('updated_at', 'desc')
      .select('payload');

    const matched: ThreadCheckpoint[] = [];
    for (const row of rows) {
      if (!row?.payload) continue;
      try {
        const checkpoint = JSON.parse(row.payload) as ThreadCheckpoint;
        if (!checkpoint || checkpoint.scope !== query.scope) continue;
        matched.push(checkpoint);
        if (matched.length >= offset + limit) break;
      } catch {
        // 忽略无法解析的损坏记录
      }
    }
    return matched.slice(offset, offset + limit);
  }

  async delete(threadId: string): Promise<void> {
    const cleanId = typeof threadId === 'string' ? threadId.trim() : '';
    if (!cleanId) return;
    await this.database<MemoryRow>(memoryTable)
      .where('namespace_key', this.namespaceKey)
      .where('thread_key', sha256(cleanId))
      .del();
  }

  /**
   * 借助同一 MySQL 会话上的 GET_LOCK / RELEASE_LOCK 实现跨实例同线程串行化。
   */
  async runTurn<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const lockName = `flico_mem_${sha256(`${this.namespaceKey}:${threadId}`).slice(0, 48)}`;
    return this.database.transaction(async (trx) => {
      const [rows] = await trx.raw('SELECT GET_LOCK(?, ?) AS acquired', [lockName, this.lockTimeoutSeconds]);
      const acquired = Array.isArray(rows) ? Number((rows[0] as { acquired?: unknown })?.acquired) : Number(rows?.acquired);
      if (acquired !== 1) {
        throw new Error(`Timed out waiting for MySQL thread lock "${threadId}"`);
      }
      try {
        return await task();
      } finally {
        await trx.raw('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => undefined);
      }
    });
  }
}
