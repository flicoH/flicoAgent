import type Knex from 'knex';
import { createHash } from 'node:crypto';
import { knowledgeKind } from '../store.interface';
import type { IndexedChunk, IndexedDocument, KnowledgeKind, VectorQueryResult, VectorRecord, VectorStore } from '../store.interface';
import { rankVectors } from '../vector-similarity';

const chunksTable = 'flico_rag_chunks';
const namespacesTable = 'flico_rag_namespaces';
const batchSize = 100;
const kindSql = "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.kind')), 'rag')";
const ownerSql = "JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.wiki.ownerDocId')) COLLATE utf8mb4_0900_bin";

interface ChunkRow {
  namespace_key: string;
  source_key: string;
  doc_key: string;
  chunk_key: string;
  doc_id: string;
  chunk_id: string;
  content: string;
  embedding: number[] | string;
  metadata: Record<string, unknown> | string | null;
}

function key(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function indexedChunk(row: Pick<ChunkRow, 'chunk_id' | 'doc_id' | 'content' | 'metadata'>): IndexedChunk {
  const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
  return { id: row.chunk_id, docId: row.doc_id, text: row.content, meta: metadata ?? undefined };
}

function vectorRecord(row: Pick<ChunkRow, 'chunk_id' | 'doc_id' | 'content' | 'metadata' | 'embedding'>): VectorRecord {
  return {
    ...indexedChunk(row),
    embedding: typeof row.embedding === 'string' ? JSON.parse(row.embedding) as number[] : row.embedding,
  };
}

export class MysqlVectorStore implements VectorStore {
  private readonly namespaceKey: string;

  constructor(private readonly database: Knex, namespace: string) {
    this.namespaceKey = key(namespace);
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    if (!records.length) return;
    const rows = [...new Map(records.map(record => [record.id, this.row(record)])).values()];
    await this.write(async transaction => {
      for (let start = 0; start < rows.length; start += batchSize) {
        const batch = rows.slice(start, start + batchSize);
        await this.chunks(transaction).whereIn('chunk_key', batch.map(row => row.chunk_key)).del();
        await transaction(chunksTable).insert(batch);
      }
    });
  }

  async syncDirectory(root: string, records: VectorRecord[], retain: ReadonlySet<string>): Promise<void> {
    const rows = records.map(record => this.row(record, root));
    await this.write(async transaction => {
      const previous = this.chunks(transaction, root);
      if (retain.size) previous.where(condition => {
        condition.whereRaw(`${kindSql} = 'wiki'`).orWhereNotIn('doc_key', [...retain].map(key));
      });
      await previous.del();
      for (let start = 0; start < rows.length; start += batchSize) {
        await transaction(chunksTable).insert(rows.slice(start, start + batchSize));
      }
    });
  }

  async documents(root: string): Promise<IndexedDocument[]> {
    const rows = await this.chunks(this.database, root).whereRaw(`${kindSql} <> 'wiki'`).select('doc_id')
      .count<{ doc_id: string; chunks: number | string }[]>('chunk_key as chunks')
      .groupBy('doc_key', 'doc_id').orderBy('doc_id');
    return rows.map(row => ({ docId: row.doc_id, chunks: Number(row.chunks) }));
  }

  async removeDocument(root: string, docId: string): Promise<number> {
    return this.write(async transaction => {
      const removed = await this.chunks(transaction, root).whereRaw(`${kindSql} <> 'wiki'`)
        .where('doc_key', key(docId)).del();
      await this.chunks(transaction, root).whereRaw(`${kindSql} = 'wiki' AND ${ownerSql} = ?`, [docId]).del();
      return removed;
    });
  }

  async loadChunk(root: string, id: string): Promise<IndexedChunk | null> {
    const row = await this.chunks(this.database, root).where('chunk_key', key(id))
      .first('chunk_id', 'doc_id', 'content', 'metadata');
    return row ? indexedChunk(row) : null;
  }

  async wikiChunks(root: string): Promise<IndexedChunk[]> {
    const rows = await this.chunks(this.database, root).whereRaw(`${kindSql} = 'wiki'`)
      .select('chunk_id', 'doc_id', 'content', 'metadata');
    return rows.map(indexedChunk);
  }

  async query(embedding: number[], topK: number, root?: string, kind: KnowledgeKind = 'rag'): Promise<VectorQueryResult[]> {
    if (!embedding?.length) return [];
    const filter = kind === 'wiki' ? `${kindSql} = 'wiki'` : `${kindSql} <> 'wiki'`;
    const rows = await this.chunks(this.database, root).whereRaw(filter)
      .select('chunk_id', 'doc_id', 'content', 'metadata', 'embedding').orderBy('chunk_key');
    return rankVectors(rows.map(vectorRecord), embedding, topK, root !== undefined);
  }

  async queryHybrid(embedding: number[], topK: number, root: string) {
    const rows = await this.chunks(this.database, root)
      .select('chunk_id', 'doc_id', 'content', 'metadata', 'embedding').orderBy('chunk_key');
    const raw: VectorRecord[] = [];
    const wiki: VectorRecord[] = [];
    for (const row of rows) {
      const record = vectorRecord(row);
      (knowledgeKind(record) === 'wiki' ? wiki : raw).push(record);
    }
    return { rag: rankVectors(raw, embedding, topK, true), wiki: rankVectors(wiki, embedding, topK, true) };
  }

  private chunks(database: Knex, root?: string) {
    const query = database<ChunkRow>(chunksTable).where('namespace_key', this.namespaceKey);
    if (root !== undefined) query.where('source_key', key(root));
    return query;
  }

  private row(record: VectorRecord, root = record.root): ChunkRow {
    return {
      namespace_key: this.namespaceKey,
      source_key: key(root ?? ''),
      doc_key: key(record.docId),
      chunk_key: key(record.id),
      doc_id: record.docId,
      chunk_id: record.id,
      content: record.text,
      embedding: JSON.stringify(record.embedding),
      metadata: record.meta === undefined ? null : JSON.stringify(record.meta),
    };
  }

  private async write<T>(operation: (transaction: Knex.Transaction) => Promise<T>): Promise<T> {
    return this.database.transaction(async transaction => {
      // Serialize publication across app processes that share this namespace.
      await transaction.raw(
        'INSERT INTO ?? (namespace_key) VALUES (?) ON DUPLICATE KEY UPDATE namespace_key = ?',
        [namespacesTable, this.namespaceKey, this.namespaceKey],
      );
      return operation(transaction);
    });
  }
}
