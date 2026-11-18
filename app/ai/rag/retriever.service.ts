import { Inject, Injectable } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { ConfigService } from '../../config/config.service';
import { VECTOR_STORE, VectorQueryResult, VectorRecord, VectorStore } from '../store/store.interface';
import { resolveChunker } from './chunker';
import { resolveEmbedder } from './internal/load-embedding-config';
import { resolveRagOptions } from './internal/load-rag-config';
import { Chunk } from './rag.interface';

/**
 * 检索结果载荷契约
 */
export interface RetrieveResult {
  /** 命中的分块切片数组 */
  hits: VectorQueryResult[];
}

/**
 * 递归扫描目录下支持的文件。扩展名匹配不区分大小写；符号链接不会作为文件或目录跟随。
 * 目录不存在时视为空知识库，目录读取本身失败则由调用方处理。
 */
async function scanTextFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  if (!existsSync(dir)) {
    return results;
  }

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await scanTextFiles(fullPath)));
    } else if (entry.isFile()) {
      const name = entry.name.toLowerCase();
      if (
        name.endsWith('.md')
        || name.endsWith('.txt')
        || name.endsWith('.markdown')
        || name.endsWith('.json')
      ) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

/**
 * 知识检索器服务 (RetrieverService)
 *
 * 【架构职责】
 * 统一调度文档切分、文本向量化与向量存储库检索：
 * 1. ingestFromDirectory：从指定目录批量读取文件、分块、向量化并持久化至 VectorStore；
 * 2. retrieve：将用户 query 计算为向量并从 VectorStore 中检索 TopK 最相关片段；
 * 3. 严格遵循 ai.rag 配置与框架默认值。
 */
@Injectable()
export class RetrieverService {
  constructor(
    @Inject(VECTOR_STORE) private readonly vectorStore: VectorStore,
    private readonly configService: ConfigService,
  ) {}

  /**
   * 从指定目录批量灌入并构建知识库切片
   *
   * @param dir 知识库文本根目录绝对路径
   * @returns 灌库统计：ingested 是扫描到的文件数（包括读取失败的文件），chunks 是写入的切片数
   */
  async ingestFromDirectory(dir: string): Promise<{ ingested: number; chunks: number }> {
    const filePaths = await scanTextFiles(dir);
    if (filePaths.length === 0) {
      return { ingested: 0, chunks: 0 };
    }

    const ragOptions = resolveRagOptions(this.configService);
    const chunker = resolveChunker(ragOptions);

    const allChunks: Array<{ docId: string; text: string; meta?: Record<string, unknown> }> = [];

    for (const filePath of filePaths) {
      try {
        const text = await readFile(filePath, 'utf8');
        const docId = relative(dir, filePath) || filePath;
        const chunks: Chunk[] = chunker.chunk(text, { docId, filePath });

        for (const item of chunks) {
          allChunks.push({
            docId,
            text: item.text,
            meta: {
              ...(item.meta ?? {}),
              docId,
              filePath,
            },
          });
        }
      } catch (err: any) {
        console.warn(`[RetrieverService] failed to read file "${filePath}":`, err.message);
      }
    }

    if (allChunks.length === 0) {
      return { ingested: filePaths.length, chunks: 0 };
    }

    // 保持切片顺序：下方通过数组下标把向量与原文配对，EmbeddingProvider 需按输入顺序返回。
    const texts = allChunks.map(c => c.text);
    const embeddings = await resolveEmbedder(this.configService).embed(texts);

    // ID 的下标来自本次所有文件的切片序列，而非单个文件内的序号。
    // upsert 只覆盖同 ID 的记录，不会删除前一次灌库留下的其他记录。
    const records: VectorRecord[] = allChunks.map((chunkItem, idx) => ({
      id: `${chunkItem.docId}#${idx}`,
      docId: chunkItem.docId,
      text: chunkItem.text,
      embedding: embeddings[idx],
      meta: chunkItem.meta,
    }));

    await this.vectorStore.upsert(records);

    return {
      ingested: filePaths.length,
      chunks: records.length,
    };
  }

  /**
   * 语义相关度检索
   *
   * @param query 检索自然语言输入
   * @param topK 可选指定返回数量（未传时默认读取 ai.rag.topK）
   * @returns 命中片段列表对象 { hits: [...] }
   */
  async retrieve(query: string, topK?: number): Promise<RetrieveResult> {
    const ragOptions = resolveRagOptions(this.configService);
    const limit = topK ?? ragOptions.topK;

    const [queryEmbedding] = await resolveEmbedder(this.configService).embed([query]);
    if (!queryEmbedding || queryEmbedding.length === 0) {
      return { hits: [] };
    }

    const hits = await this.vectorStore.query(queryEmbedding, limit);
    return { hits };
  }
}
