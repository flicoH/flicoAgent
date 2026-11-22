import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { EmbeddingProvider } from '../contracts';
import { ConfigService } from '../../config/config.service';
import { VECTOR_STORE } from '../store/store.interface';
import type { IndexedChunk, IndexedDocument, KnowledgeKind, VectorQueryResult, VectorRecord, VectorStore } from '../store/store.interface';
import { resolveChunker } from './chunker';
import { resolveEmbedder } from './internal/load-embedding-config';
import { resolveRagFixturesPath, resolveRagOptions } from './internal/load-rag-config';
import type { Chunk } from './rag.interface';
import { directoryRagSource, RAG_SOURCE, RagDirectoryNotFound } from './rag-source';
import type { RagSource } from './rag-source';
import { compileWiki, wikiEmbeddingText, wikiPage, wikiPages } from './wiki';

export interface RetrieveResult {
  hits: VectorQueryResult[];
}

export interface RagRebuildResult {
  ingested: number;
  chunks: number;
  succeeded: string[];
  skipped: string[];
  failed: { docId: string; stage: 'read' | 'embed' }[];
  wiki?: { pages: number; sections: number; generatedSections: number };
}

function fuseRankings(raw: VectorQueryResult[], wiki: VectorQueryResult[], limit: number): VectorQueryResult[] {
  const ranking = new Map<string, { hit: VectorQueryResult; score: number }>();
  for (const hits of [raw, wiki]) {
    for (const [index, hit] of hits.entries()) {
      const entry = ranking.get(hit.id) ?? { hit, score: 0 };
      entry.score += 1 / (60 + index + 1);
      ranking.set(hit.id, entry);
    }
  }
  return [...ranking.values()]
    .sort((a, b) => b.score - a.score || b.hit.score - a.hit.score || a.hit.id.localeCompare(b.hit.id))
    .slice(0, Math.max(1, limit)).map(({ hit, score }) => ({ ...hit, score }));
}

function isEmbedding(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && Array.from(value).every(Number.isFinite);
}

function indexedLocation(text: string, chunk: Chunk): { start: number; end: number } | undefined {
  const { start, end } = chunk.meta ?? {};
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isInteger(start) || !Number.isInteger(end)
    || start < 0 || start >= end || end > text.length) return undefined;
  const window = text.slice(start, end);
  if (window === chunk.text) return { start, end };
  if (window.trim() !== chunk.text) return undefined;
  const exactStart = start + window.length - window.trimStart().length;
  return { start: exactStart, end: exactStart + chunk.text.length };
}

@Injectable()
export class RetrieverService {
  private mutations = Promise.resolve();

  constructor(
    @Inject(VECTOR_STORE) private readonly vectorStore: VectorStore,
    private readonly configService: ConfigService,
    @Inject(RAG_SOURCE) private readonly source: RagSource = directoryRagSource(resolveRagFixturesPath(configService)),
  ) {}

  ingestFromDirectory(dir: string): Promise<RagRebuildResult> {
    return this.mutate(() => this.indexSource(directoryRagSource(dir), false));
  }

  rebuild(dir?: string): Promise<RagRebuildResult> {
    return this.mutate(() => this.indexSource(dir === undefined ? this.source : directoryRagSource(dir), true));
  }

  listDocuments(dir?: string): Promise<IndexedDocument[]> {
    if (!this.vectorStore.documents) throw new Error('VectorStore does not support listing documents');
    return this.vectorStore.documents(this.sourceKey(dir));
  }

  deleteDocument(dir: string | undefined, docId: string): Promise<number> {
    return this.mutate(async () => {
      if (!this.vectorStore.removeDocument) throw new Error('VectorStore does not support removing documents');
      return this.vectorStore.removeDocument(this.sourceKey(dir), docId);
    });
  }

  loadChunk(dir: string | undefined, id: string): Promise<IndexedChunk | null> {
    if (!this.vectorStore.loadChunk) throw new Error('VectorStore does not support loading chunks');
    return this.vectorStore.loadChunk(this.sourceKey(dir), id);
  }

  async listWikiPages() {
    return wikiPages(await this.vectorStore.wikiChunks?.(this.source.key) ?? []);
  }

  async loadWikiPage(id: string) {
    return wikiPage(await this.vectorStore.wikiChunks?.(this.source.key) ?? [], id);
  }

  preview(dir: string | undefined, query: string, topK?: number): Promise<RetrieveResult> {
    return this.retrieve(query, topK, this.sourceKey(dir));
  }

  async retrieve(query: string, topK?: number, root?: string): Promise<RetrieveResult> {
    const { mode, topK: defaultLimit } = resolveRagOptions(this.configService);
    const limit = topK ?? defaultLimit;
    if (mode !== 'rag' && !this.vectorStore.wikiChunks) throw new Error('VectorStore does not support Wiki retrieval');
    const [embedding] = await resolveEmbedder(this.configService).embed([query]);
    if (!isEmbedding(embedding)) return { hits: [] };
    if (mode === 'rag') return { hits: await this.vectorStore.query(embedding, limit, root, 'rag') };
    const search = (kind: KnowledgeKind) => this.vectorStore.query(embedding, limit, root ?? this.source.key, kind);
    if (mode === 'wiki') return { hits: await search('wiki') };
    if (this.vectorStore.queryHybrid) {
      const { rag, wiki } = await this.vectorStore.queryHybrid(embedding, limit, root ?? this.source.key);
      return { hits: fuseRankings(rag, wiki, limit) };
    }
    const [raw, wiki] = await Promise.all([search('rag'), search('wiki')]);
    return { hits: fuseRankings(raw, wiki, limit) };
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation);
    this.mutations = result.then(() => undefined, () => undefined);
    return result;
  }

  private sourceKey(dir?: string): string {
    return dir === undefined ? this.source.key : resolve(dir);
  }

  private async indexSource(source: RagSource, rebuild: boolean): Promise<RagRebuildResult> {
    if (rebuild && !this.vectorStore.syncDirectory) throw new Error('VectorStore does not support rebuilding the index');
    const root = source.key;
    const options = resolveRagOptions(this.configService);
    const wikiEnabled = options.mode !== 'rag';
    if (wikiEnabled && (!this.vectorStore.wikiChunks || !this.vectorStore.syncDirectory)) {
      throw new Error('VectorStore does not support Wiki indexing');
    }
    const result: RagRebuildResult = { ingested: 0, chunks: 0, succeeded: [], skipped: [], failed: [] };
    if (wikiEnabled) result.wiki = { pages: 0, sections: 0, generatedSections: 0 };
    const documents = await source.documents().catch(error => {
      // 兼容直接灌库时根目录缺失的空结果。重建时目录扫描必须完整成功。
      if (!rebuild && error instanceof RagDirectoryNotFound) return null;
      throw error;
    });
    if (!documents?.length) {
      if (documents && this.vectorStore.syncDirectory) await this.vectorStore.syncDirectory(root, [], new Set());
      return result;
    }

    const chunker = resolveChunker(options);
    const records: VectorRecord[] = [];
    let embedder: EmbeddingProvider | undefined;
    let dimensions: number | undefined;
    for (const { docId, filePath, read } of documents) {
      const sourceMeta = { ...source.meta, docId, ...(filePath === undefined ? {} : { filePath }) };
      let text: string;
      let chunks: Chunk[];
      try {
        text = await read();
        chunks = chunker.chunk(text, { ...sourceMeta });
      } catch {
        result.failed.push({ docId, stage: 'read' });
        continue;
      }
      if (!chunks.length) {
        result.skipped.push(docId);
        continue;
      }

      try {
        embedder ??= resolveEmbedder(this.configService);
        const embeddings = await embedder.embed(chunks.map(chunk => chunk.text));
        const expectedDimensions = dimensions ?? embeddings[0]?.length;
        if (embeddings.length !== chunks.length || Array.from(embeddings).some(
          embedding => !isEmbedding(embedding) || embedding.length !== expectedDimensions,
        )) throw new Error('Invalid document embeddings');
        const version = createHash('sha256').update(text).digest('hex');
        const documentRecords = chunks.map((chunk, index) => {
          const { start, end, kind, wiki, ...meta } = chunk.meta ?? {};
          const location = indexedLocation(text, chunk);
          const identity = JSON.stringify([root, docId, version, index, location, chunk.text]);
          return {
            id: createHash('sha256').update(identity).digest('hex'),
            docId,
            root,
            text: chunk.text,
            embedding: embeddings[index],
            meta: { ...meta, ...sourceMeta, relativePath: docId, version, ...location },
          };
        });
        for (const record of documentRecords) records.push(record);
        dimensions = expectedDimensions;
        result.succeeded.push(docId);
      } catch {
        result.failed.push({ docId, stage: 'embed' });
      }
    }

    const retain = new Set(result.failed.map(({ docId }) => docId));
    let wikiRecords: VectorRecord[] = [];
    if (wikiEnabled) {
      const previous = await this.vectorStore.wikiChunks!(root);
      const built = await compileWiki(this.configService, root, records, previous, retain, options.wiki?.model);
      if (built.sections.length) {
        embedder ??= resolveEmbedder(this.configService);
        for (let start = 0; start < built.sections.length; start += 32) {
          const batch = built.sections.slice(start, start + 32);
          const vectors = await embedder.embed(batch.map(wikiEmbeddingText));
          dimensions ??= vectors[0]?.length;
          if (vectors.length !== batch.length || Array.from(vectors).some(
            vector => !isEmbedding(vector) || vector.length !== dimensions,
          )) throw new Error('Invalid Wiki section embeddings');
          wikiRecords = wikiRecords.concat(batch.map((chunk, index) => ({ ...chunk, root, embedding: vectors[index] })));
        }
      }
      result.wiki = { pages: built.pages, sections: wikiRecords.length, generatedSections: built.generated };
    }
    if (this.vectorStore.syncDirectory) {
      await this.vectorStore.syncDirectory(root, records.concat(wikiRecords), retain);
    } else if (records.length) {
      // 旧扩展仅支持按旧 ID 更新，保留其直接灌库行为。
      await this.vectorStore.upsert(records.map((record, index) => ({ ...record, id: `${record.docId}#${index}` })));
    }
    result.ingested = documents.length;
    result.chunks = records.length;
    return result;
  }
}
