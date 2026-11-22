import { Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { IndexedChunk, IndexedDocument, KnowledgeKind, VectorQueryResult, VectorRecord, VectorStore } from '../store.interface';

interface Point {
  id: string;
  vector?: number[];
  payload: IndexedChunk;
}

interface PointQueryResult {
  points: (Point & { score: number })[];
}

interface CollectionAlias {
  alias_name: string;
  collection_name: string;
}

type Condition = Filter | { key: string; match: { value: string } | { any: string[] } };
interface Filter {
  must?: Condition[];
  must_not?: Condition[];
  should?: Condition[];
}

const wikiCondition: Condition = { key: 'meta.kind', match: { value: 'wiki' } };
const rawFilter: Filter = { must_not: [wikiCondition] };
const wikiFilter: Filter = { must: [wikiCondition] };
const batchSize = 100;

class QdrantRequestError extends Error {
  constructor(method: string, path: string, readonly status: number) {
    super(`Qdrant request failed (${method} ${path}, HTTP ${status})`);
  }
}

function results({ points }: PointQueryResult): VectorQueryResult[] {
  return points.map(({ payload, score }) => ({ ...payload, score }));
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function pointId(id: string): string {
  const value = hash(id);
  return [value.slice(0, 8), value.slice(8, 12), value.slice(12, 16), value.slice(16, 20), value.slice(20, 32)].join('-');
}

export class QdrantVectorStore implements VectorStore {
  private readonly logger = new Logger(QdrantVectorStore.name);
  private readonly aliasPrefix: string;
  private readonly endpoint: string;
  private writes = Promise.resolve();

  constructor(url: string, namespace: string, private readonly dimensions: number, private readonly apiKey?: string) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('Invalid Qdrant URL');
    }
    if (!Number.isSafeInteger(dimensions) || dimensions < 1) throw new Error('Invalid Qdrant vector dimensions');
    this.endpoint = parsed.href.replace(/\/+$/, '');
    this.aliasPrefix = 'flico-rag-' + hash(namespace).slice(0, 24) + '-';
  }

  async syncDirectory(root: string, records: VectorRecord[], retain: ReadonlySet<string>): Promise<void> {
    await this.write(() => this.replace(this.alias(root), records, retain));
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    const byAlias = new Map<string, VectorRecord[]>();
    for (const record of records) {
      const alias = this.alias(record.root ?? '');
      const batch = byAlias.get(alias) ?? [];
      batch.push(record);
      byAlias.set(alias, batch);
    }
    await this.write(async () => {
      for (const [alias, entries] of byAlias) {
        if (await this.activeCollection(alias)) await this.putPoints(alias, entries.map(record => this.point(record)));
        else await this.replace(alias, entries, new Set());
      }
    });
  }

  async documents(root: string): Promise<IndexedDocument[]> {
    return this.readSnapshot(root, [], collection => this.withWikiIndex(collection, async indexed => {
      const counts = new Map<string, number>();
      for await (const page of this.pages(collection, { filter: indexed ? rawFilter : undefined, with_payload: ['docId'] })) {
        for (const { payload } of page) counts.set(payload.docId, (counts.get(payload.docId) ?? 0) + 1);
      }
      return [...counts.keys()].sort().map(docId => ({ docId, chunks: counts.get(docId)! }));
    }));
  }

  async removeDocument(root: string, docId: string): Promise<number> {
    const alias = this.alias(root);
    return this.write(() => this.withWikiIndex(alias, async indexed => {
      const filter: Filter = { ...(indexed ? rawFilter : {}), must: [{ key: 'docId', match: { value: docId } }] };
      const { count } = await this.request<{ count: number }>(
        'POST', `/collections/${alias}/points/count`, { filter, exact: true }, { count: 0 },
      );
      if (count) {
        const owned: Condition = { must: [wikiCondition, { key: 'meta.wiki.ownerDocId', match: { value: docId } }] };
        await this.request('POST', `/collections/${alias}/points/delete?wait=true&ordering=strong`, {
          filter: indexed ? { should: [filter, owned] } : filter,
        });
      }
      return count;
    }));
  }

  async loadChunk(root: string, id: string): Promise<IndexedChunk | null> {
    const point = await this.request<Point | null>('GET', `/collections/${this.alias(root)}/points/${pointId(id)}`, undefined, null);
    return point?.payload.id === id ? point.payload : null;
  }

  async wikiChunks(root: string): Promise<IndexedChunk[]> {
    return this.readSnapshot(root, [], collection => this.withWikiIndex(collection, async indexed => {
      if (!indexed) return [];
      const sections: IndexedChunk[] = [];
      for await (const page of this.pages(collection, { filter: wikiFilter, with_payload: true })) {
        for (const { payload } of page) sections.push(payload);
      }
      return sections;
    }));
  }

  async query(embedding: number[], topK: number, root?: string, kind: KnowledgeKind = 'rag'): Promise<VectorQueryResult[]> {
    if (!embedding?.length) return [];
    this.checkDimensions(embedding);
    const limit = Math.max(1, topK);
    const filter = kind === 'wiki' ? wikiFilter : rawFilter;
    const aliases = root === undefined ? (await this.aliases()).map(item => item.alias_name) : [this.alias(root)];
    const hits = await Promise.all(aliases.map(alias => this.withWikiIndex(alias, async indexed => {
      if (!indexed && kind === 'wiki') return [];
      return this.queryPoints(alias, embedding, limit, indexed ? filter : undefined);
    })));
    return hits.flat().sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async queryHybrid(embedding: number[], topK: number, root: string) {
    if (!embedding?.length) return { rag: [], wiki: [] };
    this.checkDimensions(embedding);
    const alias = this.alias(root);
    const limit = Math.max(1, topK);
    return this.withWikiIndex(alias, async indexed => {
      if (!indexed) return { rag: await this.queryPoints(alias, embedding, limit), wiki: [] };
      const searches = [rawFilter, wikiFilter].map(filter => ({ query: embedding, limit, filter, with_payload: true }));
      const [raw, wiki] = await this.request<[PointQueryResult, PointQueryResult]>(
        'POST', `/collections/${alias}/points/query/batch`, { searches }, [{ points: [] }, { points: [] }],
      );
      return { rag: results(raw), wiki: results(wiki) };
    });
  }

  private async queryPoints(alias: string, embedding: number[], limit: number, filter?: Filter): Promise<VectorQueryResult[]> {
    return results(await this.request<PointQueryResult>(
      'POST', `/collections/${alias}/points/query`, { query: embedding, limit, filter, with_payload: true }, { points: [] },
    ));
  }

  private async withWikiIndex<T>(collection: string, operation: (indexed: boolean) => Promise<T>): Promise<T> {
    try {
      return await operation(true);
    } catch (error) {
      if (!(error instanceof QdrantRequestError) || error.status !== 400) throw error;
      // Strict Qdrant collections built before Wiki have no kind index and contain only raw chunks.
      const info = await this.request<{ payload_schema: Record<string, unknown> } | null>(
        'GET', `/collections/${collection}`, undefined, null,
      );
      if (!info || Object.hasOwn(info.payload_schema ?? {}, 'meta.kind')) throw error;
      return operation(false);
    }
  }

  private async replace(alias: string, records: VectorRecord[], retain: ReadonlySet<string>): Promise<void> {
    const previous = await this.activeCollection(alias);
    const staging = `${alias}-${randomUUID()}`;
    const points = records.map(record => this.point(record));
    try {
      await this.request('PUT', `/collections/${staging}`, { vectors: { size: this.dimensions, distance: 'Cosine' } });
      for (const field of ['docId', 'meta.kind', 'meta.wiki.ownerDocId']) {
        await this.request('PUT', `/collections/${staging}/index?wait=true`, { field_name: field, field_schema: 'keyword' });
      }
      if (previous && retain.size) {
        await this.withWikiIndex(previous, async indexed => {
          const filter: Filter = { ...(indexed ? rawFilter : {}), must: [{ key: 'docId', match: { any: [...retain] } }] };
          for await (const page of this.pages(previous, { filter, with_payload: true, with_vector: true }, false)) {
            await this.putPoints(staging, page);
          }
        });
      }
      await this.putPoints(staging, points);
    } catch (error) {
      await this.discard(staging);
      throw error;
    }

    const actions = [
      ...(previous ? [{ delete_alias: { alias_name: alias } }] : []),
      { create_alias: { alias_name: alias, collection_name: staging } },
    ];
    try {
      await this.request('POST', '/collections/aliases', { actions });
    } catch (error) {
      // Preserve the staging collection when a lost response leaves the alias target uncertain.
      const active = await this.activeCollection(alias).catch(() => null);
      if (active !== staging) {
        if (active !== null) await this.discard(staging);
        throw error;
      }
    }
    if (previous) await this.discard(previous);
  }

  private async readSnapshot<T>(root: string, empty: T, read: (collection: string) => Promise<T>): Promise<T> {
    const alias = this.alias(root);
    for (let attempt = 0; attempt < 2; attempt++) {
      const collection = await this.activeCollection(alias);
      if (!collection) return empty;
      const result = await read(collection);
      if (await this.activeCollection(alias) === collection) return result;
    }
    throw new Error('Qdrant index changed while listing records');
  }

  private async *pages(collection: string, options: object, optional = true): AsyncGenerator<Point[]> {
    let offset: string | undefined;
    do {
      const page = await this.request<{ points: Point[]; next_page_offset: string | null }>(
        'POST', `/collections/${collection}/points/scroll`, { limit: batchSize, offset, ...options },
        optional ? { points: [], next_page_offset: null } : undefined,
      );
      yield page.points;
      offset = page.next_page_offset ?? undefined;
    } while (offset !== undefined);
  }

  private async putPoints(collection: string, points: Point[]): Promise<void> {
    for (let start = 0; start < points.length; start += batchSize) {
      await this.request('PUT', `/collections/${collection}/points?wait=true&ordering=strong`, {
        points: points.slice(start, start + batchSize),
      });
    }
  }

  private async aliases(): Promise<CollectionAlias[]> {
    const { aliases } = await this.request<{ aliases: CollectionAlias[] }>('GET', '/aliases');
    return aliases.filter(item => item.alias_name.startsWith(this.aliasPrefix));
  }

  private async activeCollection(alias: string): Promise<string | undefined> {
    return (await this.aliases()).find(item => item.alias_name === alias)?.collection_name;
  }

  private alias(root: string): string {
    return this.aliasPrefix + hash(root).slice(0, 24);
  }

  private checkDimensions(embedding: number[]): void {
    if (embedding.length !== this.dimensions) throw new Error(`Qdrant requires ${this.dimensions} embedding dimensions`);
  }

  private point({ id, docId, text, meta, embedding }: VectorRecord): Point {
    this.checkDimensions(embedding);
    return { id: pointId(id), vector: embedding, payload: { id, docId, text, meta } };
  }

  private async discard(collection: string): Promise<void> {
    try {
      await this.request('DELETE', `/collections/${collection}`, undefined, false);
    } catch {
      this.logger.warn(`Could not remove inactive Qdrant collection ${collection}`);
    }
  }

  private write<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation);
    this.writes = result.then(() => undefined, () => undefined);
    return result;
  }

  private async request<T>(method: string, path: string, body?: object, missing?: T): Promise<T> {
    const response = await fetch(this.endpoint + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { 'api-key': this.apiKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 404 && missing !== undefined) return missing;
      throw new QdrantRequestError(method, path, response.status);
    }
    const { result } = await response.json() as { result: T };
    return result;
  }
}
