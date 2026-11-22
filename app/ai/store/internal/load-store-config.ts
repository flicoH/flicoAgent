import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type Knex from 'knex';
import { ConfigService } from '../../../config/config.service';
import { FileVectorStore } from '../reference/file-vector.store';
import { MysqlVectorStore } from '../reference/mysql-vector.store';
import { QdrantVectorStore } from '../reference/qdrant-vector.store';
import type { VectorStore } from '../store.interface';

/**
 * AI Store 相关配置接口
 */
interface AiStoreConfig {
  store?: {
    /** Trace 日志保存目录，支持相对路径或绝对路径，默认 'data/trace' */
    trace?: unknown;
    /** Vector 向量索引保存路径，支持文件路径或目录，默认 'data/vector.json' */
    vector?: unknown;
    /** Memory 会话检查点保存目录，默认 'data/memory' */
    memory?: unknown;
  };
}

/**
 * 解析 Trace 存储目录的绝对物理路径
 *
 * 【解析规则】
 * 1. 从配置中读取 `ai.store.trace`；
 * 2. 若未配置或为空字符串，检查工作目录下是否存在 `data/trace` 或 `.elpis/trace`，默认使用 `data/trace`；
 * 3. 通过 `path.resolve(process.cwd(), tracePath)` 将相对路径锚定至当前业务工程工作目录；若本身已是绝对路径则保持不变。
 *
 * @param config 全局配置服务
 * @returns Trace 存储根目录绝对路径
 */
export function resolveTraceStorePath(config: ConfigService): string {
  const configured = config.get<AiStoreConfig>('ai')?.store?.trace;
  if (typeof configured === 'string' && configured.trim()) {
    return resolve(process.cwd(), configured.trim());
  }

  const dataTrace = resolve(process.cwd(), 'data/trace');
  const elpisTrace = resolve(process.cwd(), '.elpis/trace');
  if (existsSync(dataTrace)) {
    return dataTrace;
  }
  if (existsSync(elpisTrace)) {
    return elpisTrace;
  }
  // 默认使用 data/trace（契合 elpis-demo 规范标准）
  return dataTrace;
}

/**
 * 解析 Vector 存储文件或目录的绝对物理路径
 *
 * 【解析规则】
 * 1. 优先读取 `ai.store.vector`（若为字符串则直接使用，若为对象则读其 path 属性）；
 * 2. 未配置时默认使用工作目录下的 `data/vector.json`；
 * 3. 通过 path.resolve 转为绝对路径。
 *
 * @param config 全局配置服务
 * @returns Vector 存储绝对路径
 */
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
  if (connection?.client.dialect !== 'mysql') {
    throw new Error(`${option} requires a MySQL connection configured in db`);
  }
  return connection;
}

interface VectorStoreOptions {
  driver?: 'file' | 'mysql' | 'qdrant';
  namespace?: string;
  url?: string;
  apiKey?: string;
  dimensions?: number;
  use?: VectorStore | ((config: ConfigService) => VectorStore | Promise<VectorStore>);
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
  const namespace = settings.namespace ?? 'default';
  if (typeof namespace !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(namespace)) {
    throw new Error('Invalid ai.store.vector.namespace');
  }
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
