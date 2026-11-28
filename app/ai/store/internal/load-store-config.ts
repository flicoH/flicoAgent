import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type Knex from 'knex';
import { ConfigService } from '../../../config/config.service';
import { resolveMemoryPath } from '../../memory/internal/load-memory-config';
import { FileMemoryStore } from '../reference/file-memory.store';
import { FileTraceStore } from '../reference/file-trace.store';
import { FileVectorStore } from '../reference/file-vector.store';
import { MysqlMemoryStore } from '../reference/mysql-memory.store';
import { MysqlTraceStore } from '../reference/mysql-trace.store';
import { MysqlVectorStore } from '../reference/mysql-vector.store';
import { QdrantVectorStore } from '../reference/qdrant-vector.store';
import { RedisLikeClient, RedisMemoryStore, RedisTraceStore } from '../reference/redis-store';
import type { MemoryStore, TraceStore, VectorStore } from '../store.interface';

interface AiStoreConfig {
  store?: {
    trace?: unknown;
    vector?: unknown;
    memory?: unknown;
  };
}

interface TraceStoreOptions {
  driver?: 'file' | 'mysql' | 'redis';
  path?: string;
  namespace?: string;
  prefix?: string;
  ttlMs?: number;
  client?: RedisLikeClient;
  use?: TraceStore | ((config: ConfigService) => TraceStore | Promise<TraceStore>);
}

interface MemoryStoreConfigOptions {
  driver?: 'file' | 'mysql' | 'redis';
  path?: string;
  namespace?: string;
  prefix?: string;
  ttlMs?: number;
  lockTtlMs?: number;
  lockTimeoutMs?: number;
  lockTimeoutSeconds?: number;
  client?: RedisLikeClient;
  use?: MemoryStore | ((config: ConfigService) => MemoryStore | Promise<MemoryStore>);
}

interface VectorStoreOptions {
  driver?: 'file' | 'mysql' | 'qdrant';
  namespace?: string;
  url?: string;
  apiKey?: string;
  dimensions?: number;
  use?: VectorStore | ((config: ConfigService) => VectorStore | Promise<VectorStore>);
}

function validateNamespace(namespace: unknown, option: string): string {
  const value = namespace ?? 'default';
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(value)) {
    throw new Error(`Invalid ${option}.namespace`);
  }
  return value;
}

export function resolveTraceStorePath(config: ConfigService): string {
  const configured = config.get<AiStoreConfig>('ai')?.store?.trace
    ?? config.get<unknown>('ai.store.trace');
  if (typeof configured === 'string' && configured.trim()) {
    return resolve(process.cwd(), configured.trim());
  }
  if (configured && typeof configured === 'object') {
    const customPath = (configured as { path?: unknown }).path;
    if (typeof customPath === 'string' && customPath.trim()) {
      return resolve(process.cwd(), customPath.trim());
    }
  }

  const dataTrace = resolve(process.cwd(), 'data/trace');
  const elpisTrace = resolve(process.cwd(), '.elpis/trace');
  if (existsSync(dataTrace)) {
    return dataTrace;
  }
  if (existsSync(elpisTrace)) {
    return elpisTrace;
  }
  return dataTrace;
}

export function resolveVectorStorePath(config: ConfigService): string {
  const configured = config.get<AiStoreConfig>('ai')?.store?.vector
    ?? config.get<unknown>('ai.store.vector');

  if (typeof configured === 'string' && configured.trim()) {
    return resolve(process.cwd(), configured.trim());
  }

  if (configured && typeof configured === 'object') {
    const customPath = (configured as { path?: unknown }).path;
    if (typeof customPath === 'string' && customPath.trim()) {
      return resolve(process.cwd(), customPath.trim());
    }
  }

  return resolve(process.cwd(), 'data/vector.json');
}

export function requireMysqlConnection(connection: Knex | undefined, option: string): Knex {
  const dialect = (connection as { client?: { dialect?: string } } | undefined)?.client?.dialect;
  if (dialect !== 'mysql' && dialect !== 'mysql2') {
    throw new Error(`${option} requires a MySQL connection configured in db`);
  }
  return connection!;
}

export async function resolveTraceStore(config: ConfigService, connection?: Knex): Promise<TraceStore> {
  const options = config.get<AiStoreConfig>('ai')?.store?.trace ?? config.get('ai.store.trace');
  const settings = typeof options === 'object' && options !== null ? options as TraceStoreOptions : undefined;
  if (settings?.use !== undefined) {
    const store = typeof settings.use === 'function' ? await settings.use(config) : settings.use;
    if (typeof store?.save !== 'function' || typeof store?.load !== 'function') {
      throw new Error('ai.store.trace.use must provide a TraceStore');
    }
    return store;
  }
  if (!settings?.driver || settings.driver === 'file') {
    return new FileTraceStore(resolveTraceStorePath(config));
  }
  const namespace = validateNamespace(settings.namespace, 'ai.store.trace');
  if (settings.driver === 'mysql') {
    return new MysqlTraceStore(requireMysqlConnection(connection, 'ai.store.trace'), namespace);
  }
  if (settings.driver === 'redis') {
    if (!settings.client || typeof settings.client.get !== 'function' || typeof settings.client.set !== 'function') {
      throw new Error('ai.store.trace with driver "redis" requires a RedisLikeClient at client');
    }
    return new RedisTraceStore(settings.client, {
      namespace,
      prefix: settings.prefix,
      ttlMs: settings.ttlMs,
    });
  }
  throw new Error('Unsupported ai.store.trace.driver');
}

export async function resolveMemoryStore(config: ConfigService, connection?: Knex): Promise<MemoryStore> {
  const options = config.get<AiStoreConfig>('ai')?.store?.memory ?? config.get('ai.store.memory');
  const settings = typeof options === 'object' && options !== null ? options as MemoryStoreConfigOptions : undefined;
  if (settings?.use !== undefined) {
    const store = typeof settings.use === 'function' ? await settings.use(config) : settings.use;
    if (typeof store?.save !== 'function' || typeof store?.load !== 'function') {
      throw new Error('ai.store.memory.use must provide a MemoryStore');
    }
    return store;
  }
  if (!settings?.driver || settings.driver === 'file') {
    return new FileMemoryStore(resolveMemoryPath(config));
  }
  const namespace = validateNamespace(settings.namespace, 'ai.store.memory');
  if (settings.driver === 'mysql') {
    return new MysqlMemoryStore(requireMysqlConnection(connection, 'ai.store.memory'), namespace, {
      lockTimeoutSeconds: settings.lockTimeoutSeconds,
    });
  }
  if (settings.driver === 'redis') {
    if (!settings.client || typeof settings.client.get !== 'function' || typeof settings.client.set !== 'function') {
      throw new Error('ai.store.memory with driver "redis" requires a RedisLikeClient at client');
    }
    return new RedisMemoryStore(settings.client, {
      namespace,
      prefix: settings.prefix,
      ttlMs: settings.ttlMs,
      lockTtlMs: settings.lockTtlMs,
      lockTimeoutMs: settings.lockTimeoutMs,
    });
  }
  throw new Error('Unsupported ai.store.memory.driver');
}

export async function resolveVectorStore(config: ConfigService, connection?: Knex): Promise<VectorStore> {
  const options = config.get<AiStoreConfig>('ai')?.store?.vector ?? config.get('ai.store.vector');
  const settings = typeof options === 'object' && options !== null ? options as VectorStoreOptions : undefined;
  if (settings?.use !== undefined) {
    const store = typeof settings.use === 'function' ? await settings.use(config) : settings.use;
    if (typeof store?.upsert !== 'function' || typeof store?.query !== 'function') {
      throw new Error('ai.store.vector.use must provide a VectorStore');
    }
    return store;
  }
  if (!settings?.driver || settings.driver === 'file') return new FileVectorStore(resolveVectorStorePath(config));
  const namespace = validateNamespace(settings.namespace, 'ai.store.vector');
  if (settings.driver === 'mysql') {
    return new MysqlVectorStore(requireMysqlConnection(connection, 'ai.store.vector'), namespace);
  }
  if (settings.driver === 'qdrant') {
    if (typeof settings.url !== 'string' || typeof settings.dimensions !== 'number') {
      throw new Error('ai.store.vector requires a Qdrant URL and vector dimensions');
    }
    return new QdrantVectorStore(settings.url, namespace, settings.dimensions, settings.apiKey);
  }
  throw new Error('Unsupported ai.store.vector.driver');
}
