import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { VectorQueryResult, VectorRecord, VectorStore } from '../store.interface';

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
  private memoryRecords = new Map<string, VectorRecord>();
  private loaded = false;

  constructor(targetPath: string) {
    this.filePath = targetPath.endsWith('.json')
      ? targetPath
      : join(targetPath, 'index.json');

    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
    } catch {
      // 容错忽略
    }
  }

  /**
   * 首次访问时加载磁盘记录，兼容数组及 { records: [...] } 两种格式。
   * 读取或解析失败只记录警告，并将本实例标记为已加载，不会自动重试。
   */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }

    try {
      if (existsSync(this.filePath)) {
        const content = await readFile(this.filePath, 'utf8');
        const parsed = JSON.parse(content);
        const list: VectorRecord[] = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.records)
            ? parsed.records
            : [];

        this.memoryRecords.clear();
        for (const item of list) {
          if (item && item.id) {
            this.memoryRecords.set(item.id, item);
          }
        }
      }
    } catch (err: any) {
      console.warn(`[FileVectorStore] failed to load existing vectors: ${err.message}`);
    }

    this.loaded = true;
  }

  /**
   * 批量写入或更新向量切片
   */
  async upsert(records: VectorRecord[]): Promise<void> {
    await this.ensureLoaded();

    for (const record of records) {
      this.memoryRecords.set(record.id, record);
    }

    // 临时文件与目标文件位于同一目录；rename 避免读者看到部分 JSON。
    // 这是单实例参考实现：固定临时文件名和内存快照不提供并发写入协调。
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    const data = JSON.stringify({ records: [...this.memoryRecords.values()] }, null, 2);

    await writeFile(temporary, data, 'utf8');
    await rename(temporary, this.filePath);
  }

  /**
   * 对内存中全部记录计算余弦相似度并降序返回。非空索引下 topK 小于 1 时仍返回一条。
   */
  async query(embedding: number[], topK: number): Promise<VectorQueryResult[]> {
    await this.ensureLoaded();

    if (this.memoryRecords.size === 0 || !embedding || embedding.length === 0) {
      return [];
    }

    const scored: VectorQueryResult[] = [];

    for (const record of this.memoryRecords.values()) {
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
