import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { knowledgeKind, wikiOwner } from '../store.interface';
import type { IndexedChunk, IndexedDocument, KnowledgeKind, VectorQueryResult, VectorRecord, VectorStore } from '../store.interface';
import { rankVectors } from '../vector-similarity';

function belongsToDirectory(record: VectorRecord, root: string): boolean {
  if (record.root !== undefined) return record.root === root;

  // 旧索引只有在文件路径与 docId 精确对应时才能确定所属目录。
  const filePath = record.meta?.filePath;
  return isAbsolute(root) && typeof filePath === 'string' && !isAbsolute(record.docId)
    && relative(root, resolve(filePath)) === record.docId && record.docId.split(sep, 1)[0] !== '..';
}

/**
 * 文件型向量存储参考实现 (FileVectorStore)
 *
 * 【无状态框架的向量持久化实现】
 * 1. 存储结构：以单文件或目录内 index.json 方式持久化序列化向量字典；
 * 2. 原子写入：采用“先写临时文件 (.tmp) + rename 原子替换”的双阶段写入机制；
 * 3. 内存索引：启动时按需读取，磁盘发布成功后更新；
 * 4. 相似度排序：采用标准余弦相似度全量打分并提取 TopK 最相近切片。
 */
export class FileVectorStore implements VectorStore {
  private readonly filePath: string;
  private memoryRecords = new Map<string, VectorRecord>();
  private loading?: Promise<void>;
  private writes = Promise.resolve();

  constructor(targetPath: string) {
    this.filePath = targetPath.endsWith('.json')
      ? targetPath
      : join(targetPath, 'index.json');
  }

  private ensureLoaded(): Promise<void> {
    this.loading ??= this.loadRecords().catch(error => {
      this.loading = undefined;
      throw error;
    });
    return this.loading;
  }

  private async loadRecords(): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    const parsed = JSON.parse(content);
    const records: unknown = Array.isArray(parsed) ? parsed : parsed?.records;
    if (!Array.isArray(records)) throw new Error('Invalid vector index format');
    this.memoryRecords = new Map(records.filter(record => record && typeof record.id === 'string'
      && typeof record.docId === 'string').map(record => [record.id, record]));
  }

  private async publish(records: Map<string, VectorRecord>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ records: [...records.values()] }, null, 2), 'utf8');
      await rename(temporary, this.filePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    this.memoryRecords = records;
  }

  private write<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(async () => {
      await this.ensureLoaded();
      return operation();
    });
    this.writes = result.then(() => undefined, () => undefined);
    return result;
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    return this.write(async () => {
      const next = new Map(this.memoryRecords);
      for (const record of records) next.set(record.id, record);
      await this.publish(next);
    });
  }

  async syncDirectory(root: string, records: VectorRecord[], retain: ReadonlySet<string>): Promise<void> {
    return this.write(async () => {
      const next = new Map(this.memoryRecords);
      for (const [id, record] of next) {
        if (belongsToDirectory(record, root) && (knowledgeKind(record) === 'wiki' || !retain.has(record.docId))) next.delete(id);
      }
      for (const record of records) next.set(record.id, { ...record, root });
      await this.publish(next);
    });
  }

  async documents(root: string): Promise<IndexedDocument[]> {
    await this.ensureLoaded();
    const counts = new Map<string, number>();
    for (const record of this.memoryRecords.values()) {
      if (belongsToDirectory(record, root) && knowledgeKind(record) === 'rag') {
        counts.set(record.docId, (counts.get(record.docId) ?? 0) + 1);
      }
    }
    return [...counts.keys()].sort().map(docId => ({ docId, chunks: counts.get(docId)! }));
  }

  async removeDocument(root: string, docId: string): Promise<number> {
    return this.write(async () => {
      const next = new Map(this.memoryRecords);
      let removed = 0;
      for (const [id, record] of next) {
        if (!belongsToDirectory(record, root)) continue;
        if (wikiOwner(record) === docId) next.delete(id);
        if (knowledgeKind(record) === 'rag' && record.docId === docId) {
          next.delete(id);
          removed++;
        }
      }
      if (next.size !== this.memoryRecords.size) await this.publish(next);
      return removed;
    });
  }

  async loadChunk(root: string, id: string): Promise<IndexedChunk | null> {
    await this.ensureLoaded();
    const record = this.memoryRecords.get(id);
    if (!record || !belongsToDirectory(record, root)) return null;
    const { docId, text, meta } = record;
    return { id, docId, text, meta };
  }

  async wikiChunks(root: string): Promise<IndexedChunk[]> {
    await this.ensureLoaded();
    return [...this.memoryRecords.values()]
      .filter(record => belongsToDirectory(record, root) && knowledgeKind(record) === 'wiki')
      .map(({ id, docId, text, meta }) => ({ id, docId, text, meta }));
  }

  /**
   * 对内存中全部记录计算余弦相似度并降序返回。非空索引下 topK 小于 1 时仍返回一条。
   */
  async query(embedding: number[], topK: number, root?: string, kind: KnowledgeKind = 'rag'): Promise<VectorQueryResult[]> {
    await this.ensureLoaded();

    const records = [...this.memoryRecords.values()].filter(record =>
      knowledgeKind(record) === kind && (root === undefined || belongsToDirectory(record, root)));
    return rankVectors(records, embedding, topK, root !== undefined);
  }

  async queryHybrid(embedding: number[], topK: number, root: string) {
    await this.ensureLoaded();
    const raw: VectorRecord[] = [];
    const wiki: VectorRecord[] = [];
    for (const record of this.memoryRecords.values()) {
      if (belongsToDirectory(record, root)) (knowledgeKind(record) === 'wiki' ? wiki : raw).push(record);
    }
    return { rag: rankVectors(raw, embedding, topK, true), wiki: rankVectors(wiki, embedding, topK, true) };
  }
}
