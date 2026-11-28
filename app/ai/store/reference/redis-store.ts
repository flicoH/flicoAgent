import { createHash, randomUUID } from 'node:crypto';
import type { TraceRun } from '../../contracts';
import type { MemoryStore, ThreadCheckpoint, TraceListQuery, TraceStore } from '../store.interface';

/**
 * 与 ioredis / node-redis 兼容的最小 Redis 客户端契约，避免框架强绑定特定 Redis 客户端版本。
 */
export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  eval?(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
  zadd?(key: string, score: number, member: string): Promise<unknown>;
  zrevrange?(key: string, start: number, stop: number): Promise<string[]>;
  expire?(key: string, seconds: number): Promise<unknown>;
}

export interface RedisStoreCommonOptions {
  namespace?: string;
  prefix?: string;
  ttlMs?: number;
}

const RELEASE_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function scopeKey(scope?: string): string {
  return sha256(scope === undefined ? '__global__' : `scope:${scope}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class RedisTraceStore implements TraceStore {
  private readonly keyPrefix: string;
  private readonly ttlMs?: number;

  constructor(
    private readonly client: RedisLikeClient,
    options: RedisStoreCommonOptions = {},
  ) {
    const base = options.prefix ?? 'flico';
    const ns = options.namespace ?? 'default';
    this.keyPrefix = `${base}:trace:${ns}`;
    this.ttlMs = typeof options.ttlMs === 'number' && options.ttlMs > 0 ? Math.floor(options.ttlMs) : undefined;
  }

  async save(run: TraceRun): Promise<void> {
    const recordKey = `${this.keyPrefix}:run:${run.runId}`;
    const payload = JSON.stringify(run);
    if (this.ttlMs) {
      await this.client.set(recordKey, payload, 'PX', this.ttlMs);
    } else {
      await this.client.set(recordKey, payload);
    }

    if (typeof this.client.zadd === 'function') {
      const idxKey = `${this.keyPrefix}:idx:${scopeKey(run.scope)}`;
      const score = Date.parse(run.createdAt) || Date.now();
      await this.client.zadd(idxKey, score, run.runId);
      if (this.ttlMs && typeof this.client.expire === 'function') {
        await this.client.expire(idxKey, Math.max(1, Math.ceil(this.ttlMs / 1000)));
      }
    }
  }

  async load(runId: string): Promise<TraceRun | null> {
    const cleanId = typeof runId === 'string' ? decodeURIComponent(runId).replace(/^\{|\}$/g, '').trim() : '';
    if (!cleanId) return null;
    const raw = await this.client.get(`${this.keyPrefix}:run:${cleanId}`);
    return raw ? (JSON.parse(raw) as TraceRun) : null;
  }

  async list(query: TraceListQuery): Promise<TraceRun[]> {
    if (typeof this.client.zrevrange !== 'function') {
      throw new Error('RedisLikeClient must implement zrevrange to list traces');
    }
    const offset = Math.max(0, Math.floor(query.offset || 0));
    const limit = Math.max(0, Math.floor(query.limit || 0));
    if (limit === 0) return [];
    if (query.agents && query.agents.length === 0) return [];

    const idxKey = `${this.keyPrefix}:idx:${scopeKey(query.scope)}`;
    const scanLimit = query.agents ? Math.max(200, (offset + limit) * 5) : offset + limit;
    const ids = await this.client.zrevrange(idxKey, 0, scanLimit - 1);

    const matched: TraceRun[] = [];
    for (const id of ids) {
      const run = await this.load(id);
      if (!run) continue;
      if (run.scope !== query.scope) continue;
      if (query.agents && !query.agents.includes(run.agent)) continue;
      matched.push(run);
      if (matched.length >= offset + limit) break;
    }
    return matched.slice(offset, offset + limit);
  }
}

export class RedisMemoryStore implements MemoryStore {
  private readonly keyPrefix: string;
  private readonly ttlMs?: number;
  private readonly lockTtlMs: number;
  private readonly lockTimeoutMs: number;

  constructor(
    private readonly client: RedisLikeClient,
    options: RedisStoreCommonOptions & { lockTtlMs?: number; lockTimeoutMs?: number } = {},
  ) {
    const base = options.prefix ?? 'flico';
    const ns = options.namespace ?? 'default';
    this.keyPrefix = `${base}:memory:${ns}`;
    this.ttlMs = typeof options.ttlMs === 'number' && options.ttlMs > 0 ? Math.floor(options.ttlMs) : undefined;
    this.lockTtlMs = Math.max(1000, Math.floor(options.lockTtlMs ?? 60_000));
    this.lockTimeoutMs = Math.max(100, Math.floor(options.lockTimeoutMs ?? 30_000));
  }

  async save(checkpoint: ThreadCheckpoint): Promise<void> {
    if (!checkpoint || typeof checkpoint.threadId !== 'string' || !checkpoint.threadId.trim()) {
      throw new Error('ThreadCheckpoint must have a valid string threadId');
    }
    const key = this.threadKey(checkpoint.threadId);
    const payload = JSON.stringify(checkpoint);
    if (this.ttlMs) {
      await this.client.set(key, payload, 'PX', this.ttlMs);
    } else {
      await this.client.set(key, payload);
    }
  }

  async load(threadId: string): Promise<ThreadCheckpoint | null> {
    if (!threadId || typeof threadId !== 'string') return null;
    const raw = await this.client.get(this.threadKey(threadId));
    return raw ? (JSON.parse(raw) as ThreadCheckpoint) : null;
  }

  async delete(threadId: string): Promise<void> {
    if (!threadId || typeof threadId !== 'string') return;
    await this.client.del(this.threadKey(threadId));
  }

  async runTurn<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const lockKey = `${this.keyPrefix}:lock:${sha256(threadId.trim())}`;
    const token = randomUUID();
    const deadline = Date.now() + this.lockTimeoutMs;

    let acquired = false;
    while (Date.now() <= deadline) {
      const res = await this.client.set(lockKey, token, 'PX', this.lockTtlMs, 'NX');
      if (res === 'OK' || res === true) {
        acquired = true;
        break;
      }
      await sleep(15);
    }
    if (!acquired) {
      throw new Error(`Timed out waiting for Redis thread lock "${threadId}"`);
    }

    try {
      return await task();
    } finally {
      if (typeof this.client.eval === 'function') {
        await this.client.eval(RELEASE_LOCK_LUA, 1, lockKey, token).catch(() => undefined);
      } else {
        const current = await this.client.get(lockKey).catch(() => null);
        if (current === token) {
          await this.client.del(lockKey).catch(() => undefined);
        }
      }
    }
  }

  private threadKey(threadId: string): string {
    return `${this.keyPrefix}:thread:${sha256(threadId.trim())}`;
  }
}
