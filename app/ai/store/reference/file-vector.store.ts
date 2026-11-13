import { join, relative, sep } from 'node:path';
import { readFile } from 'node:fs/promises';
import { SerialByKey } from '../../../common/async/serial-by-key';
import { VectorQueryResult, VectorRecord, VectorStore } from '../store.interface';
import { writeJsonAtomically } from './write-json-atomically';

/**
 * 计算两个向量之间的余弦相似度 (Cosine Similarity)。维度不一致、空向量或零向量返回 0。
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 文件型向量存储参考实现 (FileVectorStore)
 *
 * 【无状态框架的向量持久化实现】
 * 1. 存储结构：以单文件或目录内 index.json 方式持久化序列化向量字典；
 * 2. 原子写入：采用“先写临时文件 (.tmp) + rename 原子替换”的双阶段写入机制；
 * 3. 内存索引：启动时按需读取并在 upsert 时更新；
 * 4. 相似度排序：采用标准余弦相似度全量打分并提取 TopK 最相近切片。
 */
export class FileVectorStore implements VectorStore {
  private readonly filePath: string;
  private readonly writes = new SerialByKey();
  private snapshot?: Promise<Map<string, VectorRecord>>;

  constructor(targetPath: string) {
    this.filePath = targetPath.endsWith('.json')
      ? targetPath
      : join(targetPath, 'index.json');
  }

  /**
   * 首次访问时加载磁盘记录，兼容数组及 { records: [...] } 两种格式。
   * 共享首次读取，避免并发初始化清空已写入的记录。读取失败允许重试。
   */
  private load(): Promise<Map<string, VectorRecord>> {
    this.snapshot ??= readFile(this.filePath, 'utf8').then(content => {
      const parsed = JSON.parse(content);
      const records: VectorRecord[] = Array.isArray(parsed) ? parsed : parsed?.records;
      if (!Array.isArray(records)) {
        throw new Error('Invalid file vector index');
      }
      return new Map(records.filter(item => item?.id).map(item => [item.id, item]));
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return new Map<string, VectorRecord>();
      this.snapshot = undefined;
      throw error;
    });
    return this.snapshot;
  }

  /**
   * 批量写入或更新向量切片
   */
  async upsert(records: VectorRecord[]): Promise<void> {
    await this.update(records);
  }

  async syncDirectory(input: Parameters<NonNullable<VectorStore['syncDirectory']>>[0]): Promise<void> {
    const failed = new Set(input.failedDocIds);
    const prefix = input.directory ? `${input.directory}/` : '';
    await this.update(input.records, record => {
      const docId = this.resolveDocumentId(record, input.root);
      return docId !== undefined && docId.startsWith(prefix) && !failed.has(docId);
    });
  }

  /** 将旧索引的绝对来源路径映射到当前知识库，首次同步即可清除旧切片。 */
  private resolveDocumentId(record: VectorRecord, root: string): string | undefined {
    if (record.meta?.ragRoot === root) return record.docId;

    const previousPath = record.meta?.filePath;
    const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
    if (typeof previousPath === 'string' && previousPath.startsWith(rootPrefix)) {
      return relative(root, previousPath).split(sep).join('/');
    }
    return undefined;
  }

  /** 在已提交的索引快照上按文档分组。旧索引和新索引用同一套根目录归属规则。 */
  async documents(root: string) {
    const docs = new Map<string, number>();
    for (const record of (await this.load()).values()) {
      const docId = this.resolveDocumentId(record, root);
      if (docId !== undefined) docs.set(docId, (docs.get(docId) ?? 0) + 1);
    }
    return [...docs].sort(([a], [b]) => a.localeCompare(b)).map(([docId, chunks]) => ({ docId, chunks }));
  }

  /** 文档 ID 只用于与索引键比较。删除直接提交索引变更并返回删除的切片数量。 */
  removeDocument(root: string, docId: string): Promise<number> {
    return this.update([], record => this.resolveDocumentId(record, root) === docId);
  }

  async loadChunk(root: string, chunkId: string): Promise<VectorQueryResult | null> {
    const record = (await this.load()).get(chunkId);
    if (!record || this.resolveDocumentId(record, root) === undefined) return null;
    // 直接定位没有查询向量。复用检索结果结构时用 0 占位，分数不代表实际相似度。
    return { id: record.id, docId: record.docId, text: record.text, score: 0, meta: record.meta };
  }

  private update(records: VectorRecord[], remove?: (record: VectorRecord) => boolean): Promise<number> {
    return this.writes.run(this.filePath, async () => {
      const current = await this.load();
      const next = new Map(remove ? [...current].filter(([, record]) => !remove(record)) : current);
      const removed = current.size - next.size;
      for (const record of records) next.set(record.id, record);
      if (!records.length && !removed) return 0;
      // 先提交磁盘，再发布内存快照。写失败时查询继续使用上一个已提交版本。
      await writeJsonAtomically(this.filePath, { records: [...next.values()] });
      this.snapshot = Promise.resolve(next);
      return removed;
    });
  }

  /**
   * 对内存中全部记录计算余弦相似度并降序返回。非空索引下 topK 小于 1 时仍返回一条。
   */
  async query(embedding: number[], topK: number, root?: string): Promise<VectorQueryResult[]> {
    const records = await this.load();

    if (records.size === 0 || !embedding || embedding.length === 0) {
      return [];
    }

    const scored: VectorQueryResult[] = [];

    for (const record of records.values()) {
      if (root !== undefined && this.resolveDocumentId(record, root) === undefined) continue;
      const score = cosineSimilarity(embedding, record.embedding);
      scored.push({
        id: record.id,
        docId: record.docId,
        text: record.text,
        score,
        meta: record.meta,
      });
    }

    // 按相似度降序排列
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, Math.max(1, topK));
  }
}
