import type Knex from 'knex';
import { createHash } from 'node:crypto';
import type { ConfigService } from '../../config/config.service';
import { requireMysqlConnection } from '../store/internal/load-store-config';
import type { RedisLikeClient } from '../store/reference/redis-store';

export interface NonceStore {
  /**
   * 原子消费一个 nonce。
   * @returns true 表示首次消费成功，false 表示在有效期内已被重放
   */
  consume(nonceKey: string, ttlMs: number): Promise<boolean> | boolean;
}

export interface NonceStoreOptions {
  driver?: 'memory' | 'mysql' | 'redis';
  namespace?: string;
  prefix?: string;
  client?: RedisLikeClient;
  use?: NonceStore | ((config: ConfigService) => NonceStore | Promise<NonceStore>);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class InMemoryNonceStore implements NonceStore {
  private readonly seen = new Map<string, number>();

  consume(nonceKey: string, ttlMs: number): boolean {
    const now = Date.now();
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt >= now) break;
      this.seen.delete(key);
    }
    if (this.seen.has(nonceKey)) {
      return false;
    }
    this.seen.set(nonceKey, now + ttlMs);
    return true;
  }
}

export class MysqlNonceStore implements NonceStore {
  private readonly namespaceKey: string;
  private ops = 0;

  constructor(private readonly database: Knex, namespace = 'default') {
    this.namespaceKey = sha256(namespace);
  }

  async consume(nonceKey: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const hashedKey = sha256(nonceKey);
    const expiresAt = now + ttlMs;

    // 清理过期的同名 nonce，避免长周期后键复用误判
    await this.database('flico_ai_nonces')
      .where('namespace_key', this.namespaceKey)
      .where('nonce_key', hashedKey)
      .where('expires_at', '<', now)
      .del();

    try {
      await this.database('flico_ai_nonces').insert({
        namespace_key: this.namespaceKey,
        nonce_key: hashedKey,
        expires_at: expiresAt,
      });
    } catch (error) {
      const code = (error as { code?: string; errno?: number })?.code;
      const errno = (error as { errno?: number })?.errno;
      if (code === 'ER_DUP_ENTRY' || errno === 1062) {
        return false;
      }
      throw error;
    }

    if (++this.ops % 100 === 0) {
      void this.database('flico_ai_nonces')
        .where('namespace_key', this.namespaceKey)
        .where('expires_at', '<', now)
        .del()
        .catch(() => undefined);
    }
    return true;
  }
}

export class RedisNonceStore implements NonceStore {
  private readonly prefix: string;

  constructor(
    private readonly client: RedisLikeClient,
    options: { namespace?: string; prefix?: string } = {},
  ) {
    const ns = options.namespace ?? 'default';
    const base = options.prefix ?? 'flico';
    this.prefix = `${base}:nonce:${ns}`;
  }

  async consume(nonceKey: string, ttlMs: number): Promise<boolean> {
    const key = `${this.prefix}:${sha256(nonceKey)}`;
    const result = await this.client.set(key, '1', 'PX', Math.max(1, Math.floor(ttlMs)), 'NX');
    return result === 'OK' || result === true;
  }
}

export async function resolveNonceStore(
  config: ConfigService,
  connection?: Knex,
): Promise<NonceStore> {
  const options = config.get<NonceStoreOptions>('ai.access.nonceStore');
  if (!options || typeof options !== 'object') {
    return new InMemoryNonceStore();
  }
  if (options.use !== undefined) {
    const store = typeof options.use === 'function' ? await options.use(config) : options.use;
    if (typeof store?.consume !== 'function') {
      throw new Error('ai.access.nonceStore.use must provide a NonceStore');
    }
    return store;
  }
  if (!options.driver || options.driver === 'memory') {
    return new InMemoryNonceStore();
  }
  const namespace = options.namespace ?? 'default';
  if (typeof namespace !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(namespace)) {
    throw new Error('Invalid ai.access.nonceStore.namespace');
  }
  if (options.driver === 'mysql') {
    return new MysqlNonceStore(requireMysqlConnection(connection, 'ai.access.nonceStore'), namespace);
  }
  if (options.driver === 'redis') {
    if (!options.client || typeof options.client.set !== 'function') {
      throw new Error('ai.access.nonceStore with driver "redis" requires a RedisLikeClient at client');
    }
    return new RedisNonceStore(options.client, { namespace, prefix: options.prefix });
  }
  throw new Error('Unsupported ai.access.nonceStore.driver');
}
