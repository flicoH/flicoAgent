import { Inject, Injectable, NotImplementedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { SerialByKey } from '../../common/async/serial-by-key';
import { ConfigService } from '../../config/config.service';
import { resolveEmbedder } from './internal/load-embedding-config';
import { VECTOR_STORE, VectorQueryResult, VectorRecord, VectorStore } from '../store/store.interface';
import { resolveChunker } from './chunker';
import { relativeIngestPath } from './internal/ingest-directory';
import { resolveRagOptions } from './internal/load-rag-config';
import type { Chunk, Chunker } from './rag.interface';

/**
 * 检索结果载荷契约
 */
export interface RetrieveResult {
  /** 命中的分块切片数组 */
  hits: VectorQueryResult[];
}

export interface IngestResult {
  /** 兼容旧调用方，表示本次扫描到的文件数。 */
  ingested: number;
  chunks: number;
  succeeded: string[];
  skipped: string[];
  failed: Array<{ docId: string; stage: 'read' | 'embed' }>;
}

type DocumentIngestResult =
  | { status: 'succeeded'; records: VectorRecord[] }
  | { status: 'skipped' }
  | { status: 'failed'; stage: 'read' | 'embed' };

/**
 * 递归扫描目录下支持的文件。扩展名匹配不区分大小写；符号链接不会作为文件或目录跟随。
 * 目录读取失败时由调用方报错，避免把不可读的目录当成空目录清空索引。
 */
async function scanTextFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
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
  private readonly ingests = new SerialByKey();
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
  async ingestFromDirectory(dir: string, root = dir): Promise<IngestResult> {
    // 同一知识库的全量与子目录灌库互斥，避免较早扫描的快照覆盖较新的索引。
    const [canonicalRoot, directory] = await Promise.all([realpath(resolve(root)), realpath(resolve(dir))]);
    return this.ingests.run(canonicalRoot, () => this.syncDirectory(directory, canonicalRoot));
  }

  /** 在规范化的知识库根目录下统计已写入索引的文档。只有索引中存在切片的文档才会出现。 */
  async listDocuments(root: string) {
    if (!this.vectorStore.documents) throw new NotImplementedException('Vector store does not support document listing');
    return this.vectorStore.documents(await realpath(root));
  }

  /** 删除与灌库用同一把锁，保证不会把早先扫描的快照覆盖到已删除的索引上。 */
  async deleteDocument(root: string, docId: string) {
    const store = this.vectorStore;
    const remove = store.removeDocument?.bind(store);
    if (!remove) throw new NotImplementedException('Vector store does not support document deletion');
    const canonical = await realpath(root);
    return this.ingests.run(canonical, () => remove(canonical, docId));
  }

  /** 按引用中的切片 ID 查找当前版本。Store 需校验切片属于当前配置的知识库。 */
  async loadChunk(root: string, chunkId: string) {
    if (!this.vectorStore.loadChunk) throw new NotImplementedException('Vector store does not support chunk lookup');
    return this.vectorStore.loadChunk(await realpath(root), chunkId);
  }

  /** 复用检索的向量化和 TopK 逻辑，同时要求存储层按知识库根目录过滤。 */
  async preview(root: string, query: string, topK?: number) {
    // 管理操作依赖支持知识库隔离的存储约定，旧适配器不会误返回其他根目录。
    if (!this.vectorStore.documents) throw new NotImplementedException('Vector store does not support scoped preview');
    return this.retrieve(query, topK, await realpath(root));
  }

  private async syncDirectory(dir: string, root: string): Promise<IngestResult> {
    const relativeDir = relativeIngestPath(root, dir);
    if (relativeDir === undefined) {
      throw new Error('Ingestion directory is outside the knowledge base');
    }
    if (!this.vectorStore.syncDirectory) {
      throw new Error('The configured vector store must implement syncDirectory for RAG ingestion');
    }

    const filePaths = (await scanTextFiles(dir)).sort();
    const result: IngestResult = { ingested: filePaths.length, chunks: 0, succeeded: [], skipped: [], failed: [] };
    const chunker = resolveChunker(resolveRagOptions(this.configService));
    const records: VectorRecord[] = [];
    const namespace = createHash('sha256').update(root).digest('hex');
    for (const filePath of filePaths) {
      const docId = relative(root, filePath).split(sep).join('/');
      const document = await this.indexDocument(chunker, { root, namespace, docId, filePath });
      if (document.status === 'succeeded') {
        for (const record of document.records) records.push(record);
        result.succeeded.push(docId);
      } else if (document.status === 'skipped') {
        result.skipped.push(docId);
      } else {
        result.failed.push({ docId, stage: document.stage });
      }
    }

    // 一次提交扫描结果。缺失和空文档的旧切片会清除，读取或向量化失败的文档保留上次索引。
    await this.vectorStore.syncDirectory({
      root,
      directory: relativeDir.split(sep).join('/'),
      records,
      failedDocIds: result.failed.map(file => file.docId),
    });
    result.chunks = records.length;
    return result;
  }

  /**
   * 返回单个文档的索引结果。空文档标记为 skipped，读文件或切分失败标记为 read，向量化失败标记为 embed。
   * 只有全部切片向量化成功才返回新记录。目录同步会保留失败文档的旧切片。
   */
  private async indexDocument(
    chunker: Chunker,
    { root, namespace, docId, filePath }: { root: string; namespace: string; docId: string; filePath: string },
  ): Promise<DocumentIngestResult> {
    let chunks: Chunk[];
    try {
      const text = await this.readDocument(filePath);
      chunks = chunker.chunk(text, { docId, filePath });
    } catch {
      return { status: 'failed', stage: 'read' };
    }
    if (!chunks.length) return { status: 'skipped' };

    try {
      const embeddings = await this.embedChunks(chunks);
      // 切片 ID 只依赖知识库、文档和文档内序号，与文件扫描顺序无关。
      const records = chunks.map((item, index) => ({
        id: `${namespace}/${docId}#${index}`,
        docId,
        text: item.text,
        embedding: embeddings[index],
        meta: { ...item.meta, docId, ragRoot: root, filePath },
      }));
      return { status: 'succeeded', records };
    } catch {
      return { status: 'failed', stage: 'embed' };
    }
  }

  /**
   * 检查实际路径并以禁止跟随符号链接的方式打开文件。
   * 只读取普通文件的 UTF-8 内容，读取成功或失败都关闭文件句柄。
   */
  private async readDocument(filePath: string): Promise<string> {
    if (await realpath(filePath) !== filePath) throw new Error('Unexpected file symlink');
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) throw new Error('Expected a regular file');
      return await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  }

  /** 按切片顺序分批获取向量。返回数量不匹配、向量为空或含非有限数字时抛出错误。 */
  private async embedChunks(chunks: Chunk[]): Promise<number[][]> {
    const batchSize = this.configService.get<number>('ai.rag.embeddingBatchSize') ?? 16;
    const limit = Number.isSafeInteger(batchSize) && batchSize > 0 ? batchSize : 16;
    const embeddings: number[][] = [];
    for (let index = 0; index < chunks.length; index += limit) {
      const batch = chunks.slice(index, index + limit);
      const vectors = await resolveEmbedder(this.configService).embed(batch.map(chunk => chunk.text));
      if (vectors.length !== batch.length
        || vectors.some(vector => !Array.isArray(vector) || !vector.length || !vector.every(Number.isFinite))) {
        throw new Error('Embedding provider returned invalid vectors');
      }
      for (const vector of vectors) embeddings.push(vector);
    }
    return embeddings;
  }

  /**
   * 语义相关度检索
   *
   * @param query 检索自然语言输入
   * @param topK 可选指定返回数量（未传时默认读取 ai.rag.topK）
   * @param root 可选的规范化知识库根目录，管理端预览用它把查询限制在当前知识库
   * @returns 命中片段列表对象 { hits: [...] }
   */
  async retrieve(query: string, topK?: number, root?: string): Promise<RetrieveResult> {
    const ragOptions = resolveRagOptions(this.configService);
    const limit = topK ?? ragOptions.topK;

    const [queryEmbedding] = await resolveEmbedder(this.configService).embed([query]);
    if (!queryEmbedding || queryEmbedding.length === 0) {
      return { hits: [] };
    }

    const hits = await this.vectorStore.query(queryEmbedding, limit, root);
    return { hits };
  }
}
