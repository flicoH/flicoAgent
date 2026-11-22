const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const knex = require('knex');
const request = require('supertest');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../../dist/app.module');
const { agentRequestSignature } = require('../../dist/ai/access/request-signature');
const { ToolRegistryService } = require('../../dist/ai/tool/tool-registry.service');
const { MysqlVectorStore } = require('../../dist/ai/store/reference/mysql-vector.store');
const { QdrantVectorStore } = require('../../dist/ai/store/reference/qdrant-vector.store');

const socket = process.env.RAG_MYSQL_TEST_SOCKET;
const connection = process.env.RAG_MYSQL_TEST_URL || (socket && {
  socketPath: socket, user: 'root', database: 'flico_rag_test',
});
const mysqlSuite = connection ? describe : describe.skip;
const settings = { client: 'mysql2', connection };
const qdrantUrl = process.env.RAG_QDRANT_TEST_URL;
const qdrantKey = process.env.RAG_QDRANT_TEST_KEY;
const qdrantSuite = qdrantUrl ? describe : describe.skip;
const hash = value => createHash('sha256').update(value).digest('hex');
const wikiFor = (root, record) => ({
  ...record, root, id: 'wiki-' + record.id, docId: 'wiki:policy', text: 'compiled evidence',
  meta: { kind: 'wiki', wiki: { ownerDocId: record.docId } },
});

async function clearQdrant(...namespaces) {
  const prefixes = namespaces.map(namespace => 'flico-rag-' + hash(namespace).slice(0, 24) + '-');
  const headers = qdrantKey ? { 'api-key': qdrantKey } : {};
  const response = await fetch(qdrantUrl + '/collections', { headers });
  assert.ok(response.ok);
  const { result: { collections } } = await response.json();
  for (const { name } of collections) {
    if (prefixes.some(prefix => name.startsWith(prefix))) {
      const deleted = await fetch(qdrantUrl + '/collections/' + name, { method: 'DELETE', headers });
      assert.ok(deleted.ok);
      await deleted.body?.cancel();
    }
  }
}

mysqlSuite('MySQL 知识库集成', function () {
  this.timeout(10000);
  let db;
  let namespace;
  let otherNamespace;
  let collection;
  let otherCollection;
  let fixture;
  let app;
  let vector;
  let mode;

  before(async () => {
    db = knex(settings);
    const schema = await readFile(join(__dirname, '../../docs/rag-mysql.sql'), 'utf8');
    for (const statement of schema.split(';').map(part => part.trim()).filter(Boolean)) await db.raw(statement);
  });

  beforeEach(async () => {
    namespace = 'rag-test-' + randomUUID();
    otherNamespace = namespace + '-other';
    collection = namespace;
    otherCollection = otherNamespace;
    fixture = await mkdtemp(join(tmpdir(), 'flico-rag-mysql-http-'));
    vector = { driver: 'mysql', namespace };
    mode = 'rag';
  });

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    const keys = [namespace, otherNamespace].map(hash);
    await db('flico_rag_chunks').whereIn('namespace_key', keys).del();
    await db('flico_rag_namespaces').whereIn('namespace_key', keys).del();
    await db('flico_rag_documents').whereIn('collection', [collection, otherCollection]).del();
    if (vector.driver === 'qdrant') await clearQdrant(namespace);
    await rm(fixture, { recursive: true, force: true });
  });

  after(async () => { await db?.destroy(); });

  async function start() {
    app = await NestFactory.create(AppModule.register({
      db: settings,
      ai: {
        access: { keys: { fixture: { secret: 'rag-test-secret', ingest: true } } },
        embedding: { use: { async embed(texts) {
          if (texts.some(text => text.includes('embedding unavailable'))) throw new Error('embedding unavailable');
          return texts.map(text => text.includes('退款') ? [1, 0] : [0, 1]);
        } } },
        rag: { source: { driver: 'mysql', collection }, mode },
        llm: { default: 'wiki', models: { wiki: { use: { async chat(messages) {
          const [source] = JSON.parse(messages.at(-1).content).chunks;
          return { output: JSON.stringify({ sections: [{
            pageId: 'refunds', title: '退款规则', heading: source.docId,
            markdown: source.text, chunkIds: [source.id],
          }] }) };
        } } } } },
        store: {
          trace: join(fixture, 'trace'),
          vector,
          memory: { path: join(fixture, 'memory') },
        },
      },
    }), { logger: false, rawBody: true });
    await app.init();
  }

  function send(method, path, payload) {
    const time = String(Date.now());
    const nonce = randomUUID();
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const call = request(app.getHttpServer())[method.toLowerCase()](path)
      .set('x-agent-key-id', 'fixture')
      .set('x-agent-nonce', nonce)
      .set('s_t', time)
      .set('s_sign', agentRequestSignature('rag-test-secret', 'fixture', method, path, time, nonce, body).toString('hex'));
    return body ? call.set('Content-Type', 'application/json').send(body) : call;
  }

  async function verifyHttpKnowledgeBase() {
    const rag = '/api/ai/rag';
    const docId = 'policy/退款.md';
    const body = '  退款期限为三十天。😀\n';
    const documents = db('flico_rag_documents');
    await documents.insert([
      { collection, doc_id: docId, body },
      { collection, doc_id: 'extra.md', body: 'A secondary document' },
      { collection: otherCollection, doc_id: docId, body: '另一个集合的退款文档' },
    ]);
    await start();
    const rebuild = await send('POST', rag + '/rebuild').expect(201);
    assert.deepEqual(rebuild.body.data.succeeded, ['extra.md', docId]);
    assert.equal(rebuild.body.data.chunks, 2);

    await app.close();
    await start();
    const preview = await send('POST', rag + '/preview', { query: '退款', topK: 1 }).expect(201);
    const [evidence] = preview.body.data.hits;
    assert.equal(evidence.docId, docId);
    assert.equal(evidence.score, 1);
    assert.equal(evidence.text, body.trim());
    const located = await send('GET', rag + '/chunk?id=' + evidence.id).expect(200);
    const { text, meta, citation } = located.body.data;
    assert.equal(citation, evidence.citation);
    assert.equal(body.slice(meta.start, meta.end), text);
    assert.equal(meta.source, 'mysql');
    assert.equal(meta.collection, collection);
    assert.equal(meta.relativePath, docId);
    assert.deepEqual((await app.get(ToolRegistryService).get('retrieve').execute({ query: '退款' })).hits[0], evidence);

    await db('flico_rag_documents').where({ collection, doc_id: docId }).update({ body: 'embedding unavailable' });
    await db('flico_rag_documents').where({ collection, doc_id: 'extra.md' }).del();
    const failed = await send('POST', rag + '/rebuild').expect(201);
    assert.deepEqual(failed.body.data.failed, [{ docId, stage: 'embed' }]);
    const list = await send('GET', rag + '/documents').expect(200);
    assert.deepEqual(list.body.data, [{ docId, chunks: 1 }]);
    await send('GET', rag + '/chunk?id=' + evidence.id).expect(200);

    const deletion = await send('DELETE', rag + '/documents', { docId }).expect(200);
    assert.equal(deletion.body.data.removed, 1);
    await send('GET', rag + '/chunk?id=' + evidence.id).expect(404);
    const original = await db('flico_rag_documents').where({ collection, doc_id: docId }).first('body');
    assert.equal(original.body, 'embedding unavailable');
  }

  it('通过 HTTP 从 MySQL 重建并跨应用重启读取 MySQL 索引', verifyHttpKnowledgeBase);

  (qdrantUrl ? it : it.skip)('通过 HTTP 从 MySQL 重建并跨应用重启读取 Qdrant 索引', async () => {
    vector = { driver: 'qdrant', url: qdrantUrl, apiKey: qdrantKey, dimensions: 2, namespace };
    await verifyHttpKnowledgeBase();
  });

  (qdrantUrl ? it : it.skip)('MySQL 原文编译到 Qdrant Wiki，删除原文索引同步移除 Wiki 章节', async () => {
    vector = { driver: 'qdrant', url: qdrantUrl, apiKey: qdrantKey, dimensions: 2, namespace };
    mode = 'hybrid';
    const rag = '/api/ai/rag';
    await db('flico_rag_documents').insert([
      { collection, doc_id: 'policy.md', body: '退款期限为三十天。' },
      { collection, doc_id: 'faq.md', body: '退款原路退回。' },
    ]);
    await start();
    const built = await send('POST', rag + '/rebuild').expect(201);
    assert.deepEqual(built.body.data.wiki, { pages: 1, sections: 2, generatedSections: 2 });
    const preview = await send('POST', rag + '/preview', { query: '退款', topK: 2 }).expect(201);
    assert.equal(preview.body.data.hits.length, 2);
    assert.deepEqual(new Set(preview.body.data.hits.map(hit => hit.meta.kind ?? 'rag')), new Set(['rag', 'wiki']));
    await send('DELETE', rag + '/documents', { docId: 'policy.md' }).expect(200);
    const page = await send('GET', rag + '/wiki/page?id=refunds').expect(200);
    assert.deepEqual(page.body.data.sections.map(section => section.heading), ['faq.md']);
  });

  it('MySQL 写入失败回滚旧索引并隔离命名空间和来源', async () => {
    const store = new MysqlVectorStore(db, namespace);
    const other = new MysqlVectorStore(db, otherNamespace);
    const source = 'mysql:' + collection;
    const old = { id: 'old', docId: 'policy', text: 'old evidence', embedding: [1, 0] };
    const fresh = { ...old, id: 'new', text: 'new evidence' };
    await store.syncDirectory(source, [old], new Set());
    await other.upsert([{ ...old, root: source, text: 'another namespace' }]);
    await assert.rejects(store.syncDirectory(source, [fresh, fresh], new Set()), { code: 'ER_DUP_ENTRY' });
    assert.deepEqual((await store.query([1, 0], 2, source)).map(hit => hit.text), ['old evidence']);
    assert.equal(await store.loadChunk('mysql:another-collection', old.id), null);
    assert.equal(await store.removeDocument('mysql:another-collection', old.docId), 0);
    await store.syncDirectory(source, [fresh], new Set());
    assert.equal((await store.loadChunk(source, fresh.id)).text, 'new evidence');
    assert.equal((await other.loadChunk(source, old.id)).text, 'another namespace');
    const wiki = wikiFor(source, fresh);
    await store.upsert([wiki]);
    assert.deepEqual(await store.documents(source), [{ docId: 'policy', chunks: 1 }]);
    assert.deepEqual((await store.query([1, 0], 5, source, 'wiki')).map(hit => hit.id), [wiki.id]);
    assert.deepEqual((await store.query([1, 0], 5, source)).map(hit => hit.id), [fresh.id]);
    const hybrid = await store.queryHybrid([1, 0], 5, source);
    assert.deepEqual(hybrid.rag.map(hit => hit.id), [fresh.id]);
    assert.deepEqual(hybrid.wiki.map(hit => hit.id), [wiki.id]);
    assert.equal(await store.removeDocument(source, fresh.docId), 1);
    assert.deepEqual(await store.wikiChunks(source), []);
  });
});

qdrantSuite('Qdrant 知识库集成', function () {
  this.timeout(15000);

  it('兼容缺少 Wiki 字段索引的旧 Qdrant 严格集合，并原子升级', async () => {
    const namespace = 'rag-test-' + randomUUID();
    const source = 'mysql:legacy';
    const alias = 'flico-rag-' + hash(namespace).slice(0, 24) + '-' + hash(source).slice(0, 24);
    const collection = alias + '-legacy';
    const store = new QdrantVectorStore(qdrantUrl, namespace, 2, qdrantKey);
    const raw = { id: 'old', docId: 'policy', text: 'old evidence', embedding: [1, 0] };
    const wiki = wikiFor(source, raw);
    async function send(method, path, body) {
      const response = await fetch(qdrantUrl + path, {
        method, body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', ...(qdrantKey ? { 'api-key': qdrantKey } : {}) },
      });
      assert.ok(response.ok, await response.text());
    }
    try {
      await send('PUT', '/collections/' + collection, {
        vectors: { size: 2, distance: 'Cosine' },
        strict_mode_config: { enabled: true, unindexed_filtering_retrieve: false, unindexed_filtering_update: false },
      });
      await send('PUT', '/collections/' + collection + '/index?wait=true', { field_name: 'docId', field_schema: 'keyword' });
      await send('PUT', '/collections/' + collection + '/points?wait=true', { points: [{
        id: 'e79b8675-0c66-4bcc-bd07-054432cd1df6', vector: raw.embedding,
        payload: { id: raw.id, docId: raw.docId, text: raw.text },
      }] });
      await send('POST', '/collections/aliases', { actions: [{
        create_alias: { alias_name: alias, collection_name: collection },
      }] });
      assert.deepEqual(await store.documents(source), [{ docId: 'policy', chunks: 1 }]);
      assert.deepEqual(await store.wikiChunks(source), []);
      assert.deepEqual((await store.queryHybrid([1, 0], 2, source)).rag.map(hit => hit.id), [raw.id]);
      await store.syncDirectory(source, [wiki], new Set([raw.docId]));
      const hybrid = await store.queryHybrid([1, 0], 2, source);
      assert.deepEqual(hybrid.rag.map(hit => hit.id), [raw.id]);
      assert.deepEqual(hybrid.wiki.map(hit => hit.id), [wiki.id]);
    } finally {
      await clearQdrant(namespace);
    }
  });

  it('在真实向量库中完成检索、失败回滚、分批列表和命名空间隔离', async () => {
    const namespace = 'rag-test-' + randomUUID();
    const otherNamespace = namespace + '-other';
    const source = 'mysql:test';
    const store = new QdrantVectorStore(qdrantUrl, namespace, 2, qdrantKey);
    const other = new QdrantVectorStore(qdrantUrl, otherNamespace, 2, qdrantKey);
    const first = { id: 'first', docId: 'policy', text: 'important evidence', embedding: [1, 0] };
    const wiki = wikiFor(source, first);
    const bulk = Array.from({ length: 110 }, (_, i) => ({
      id: 'second-' + i, docId: 'manual', text: 'unrelated detail', embedding: [0, 1],
    }));

    try {
      assert.deepEqual(await store.query([1, 0], 2, source), []);
      assert.deepEqual(await store.documents(source), []);
      assert.equal(await store.loadChunk(source, first.id), null);
      assert.equal(await store.removeDocument(source, first.docId), 0);
      await store.syncDirectory(source, [first, wiki, ...bulk], new Set());
      await other.upsert([{ ...first, root: source, text: 'another namespace' }]);
      assert.deepEqual(await store.documents(source), [{ docId: 'manual', chunks: 110 }, { docId: 'policy', chunks: 1 }]);
      assert.deepEqual((await store.query([1, 0], 1, source)).map(hit => hit.id), [first.id]);
      assert.deepEqual((await store.query([1, 0], 2, source, 'wiki')).map(hit => hit.id), [wiki.id]);
      assert.equal((await other.loadChunk(source, first.id)).text, 'another namespace');

      const invalid = { ...first, id: 'invalid', embedding: [NaN, 1] };
      await assert.rejects(store.syncDirectory(source, [invalid], new Set()), /Qdrant request failed/);
      assert.equal((await store.loadChunk(source, first.id)).text, first.text);
      assert.equal(await store.loadChunk('mysql:other', first.id), null);
      await store.syncDirectory(source, [wiki], new Set(['policy']));
      assert.deepEqual(await store.documents(source), [{ docId: 'policy', chunks: 1 }]);
      assert.deepEqual((await store.query([1, 0], 5)).map(hit => hit.id), [first.id]);
      assert.equal(await store.removeDocument(source, first.docId), 1);
      assert.deepEqual(await store.wikiChunks(source), []);
      assert.deepEqual(await store.query([1, 0], 2, source), []);
      assert.equal((await other.loadChunk(source, first.id)).text, 'another namespace');
    } finally {
      await clearQdrant(namespace, otherNamespace);
    }
  });
});
