const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { resolveEmbedder } = require('../../dist/ai/rag/internal/load-embedding-config');
const { FileVectorStore } = require('../../dist/ai/store/reference/file-vector.store');
const { resolveVectorStore } = require('../../dist/ai/store/internal/load-store-config');
const { resolveRagFixturesPath, resolveRagOptions } = require('../../dist/ai/rag/internal/load-rag-config');
const { chunk, resolveChunker } = require('../../dist/ai/rag/chunker');
const { collectCitations, retrievalOutput } = require('../../dist/ai/rag/citations');
const { RetrieverService } = require('../../dist/ai/rag/retriever.service');
const { ToolRegistryService } = require('../../dist/ai/tool/tool-registry.service');

describe('Embedding · RAG · VectorStore · retrieve tool · ingest', () => {
  const tmpDir = path.resolve(__dirname, '../../data/test-rag-' + Date.now());

  before(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('Embedding 配置解析', () => {
    it('resolveEmbedder 抛错当 ai.embedding 未配置或 apiKey 为占位符', () => {
      assert.throws(
        () => resolveEmbedder({ get: () => undefined }),
        /ai\.embedding is not configured/,
      );

      assert.throws(
        () => resolveEmbedder({
          get: () => ({
            provider: 'dashscope-compatible',
            baseURL: 'https://api.example.com',
            model: 'text-embedding-v3',
            apiKey: 'xxxx',
          }),
        }),
        /requires a non-placeholder apiKey/,
      );
    });

    it('resolveEmbedder 支持 use: 注入自定义 Provider', async () => {
      class MockEmbeddingProvider {
        async embed(texts) {
          return texts.map(() => [0.1, 0.2, 0.3]);
        }
      }

      const configService = {
        get: (key) => ({
          use: MockEmbeddingProvider,
        }),
      };

      const provider = resolveEmbedder(configService);
      const res = await provider.embed(['test']);
      assert.deepStrictEqual(res, [[0.1, 0.2, 0.3]]);
    });
  });

  describe('6 & 7: FileVectorStore (VectorStore)', () => {
    it('支持 upsert 并通过余弦相似度检索 query topK', async () => {
      const storeFile = path.join(tmpDir, 'vector.json');
      const store = new FileVectorStore(storeFile);

      const records = [
        { id: 'chunk-1', docId: 'doc1.md', text: 'apple fruit red', embedding: [1, 0, 0] },
        { id: 'chunk-2', docId: 'doc2.md', text: 'banana fruit yellow', embedding: [0, 1, 0] },
        { id: 'chunk-3', docId: 'doc3.md', text: 'cat pet animal', embedding: [0, 0, 1] },
      ];

      await store.upsert(records);

      // 查询 [0.9, 0.1, 0] 应该最接近 chunk-1
      const hits = await store.query([0.9, 0.1, 0], 2);
      assert.strictEqual(hits.length, 2);
      assert.strictEqual(hits[0].id, 'chunk-1');
      assert.strictEqual(hits[0].docId, 'doc1.md');
      assert.ok(hits[0].score > 0.9);
      assert.strictEqual(hits[1].id, 'chunk-2');
    });
  });

  describe('9, 10, 11: RAG Options, Config & Chunker', () => {
    it('resolveRagFixturesPath 优先读 ai.store.vector.fixturesPath', () => {
      const config1 = {
        get: (key) => {
          if (key === 'ai') {
            return {
              store: { vector: { fixturesPath: 'custom/store/fixtures' } },
              rag: { fixtures: { path: 'custom/rag/fixtures' } },
            };
          }
          return undefined;
        },
      };
      const p1 = resolveRagFixturesPath(config1);
      assert.ok(p1.endsWith('custom/store/fixtures'));

      // 缺省再读 ai.rag.fixtures.path
      const config2 = {
        get: (key) => {
          if (key === 'ai') {
            return { rag: { fixtures: { path: 'custom/rag/fixtures' } } };
          }
          return undefined;
        },
      };
      const p2 = resolveRagFixturesPath(config2);
      assert.ok(p2.endsWith('custom/rag/fixtures'));
    });

    it('resolveRagOptions 默认合并 chunk size/overlap, topK, tool 文案', () => {
      const opts = resolveRagOptions({ get: () => undefined });
      assert.strictEqual(opts.chunk.size, 500);
      assert.strictEqual(opts.chunk.overlap, 50);
      assert.strictEqual(opts.topK, 3);
      assert.strictEqual(opts.tool.name, 'retrieve');
      assert.match(opts.tool.description, /答案正文原样插入/);
    });

    it('纯函数 chunk 按给定 size 与 overlap 均匀切分', () => {
      const text = 'abcdefghijklmnopqrstuvwxyz';
      const chunks = chunk(text, { size: 10, overlap: 2 });
      assert.ok(chunks.length > 1);
      assert.strictEqual(chunks[0].text, 'abcdefghij');
      // 下一段从 8 开始 (10 - 2 = 8)
      assert.strictEqual(chunks[1].text, 'ijklmnopqr');
    });

    it('resolveChunker 若 ai.rag.chunker.use 存在则让位给业务实现', () => {
      const customChunker = {
        chunk: (text) => [{ text: 'custom:' + text }],
      };
      const chunkerInstance = resolveChunker({
        chunker: { use: customChunker },
      });
      const res = chunkerInstance.chunk('hello');
      assert.deepStrictEqual(res, [{ text: 'custom:hello' }]);
    });
  });

  describe('12, 13, 14: RetrieverService & Builtin Retrieve Tool', () => {
    it('新索引清理旧版残留，删除源文档时移除切片，向量化失败时保留上次结果', async () => {
      const docs = path.join(tmpDir, 'sync-docs');
      fs.mkdirSync(docs, { recursive: true });
      const oldPath = path.join(docs, 'old.txt');
      const keepPath = path.join(docs, 'keep.txt');
      fs.writeFileSync(keepPath, 'previous version');
      fs.writeFileSync(oldPath, 'will be deleted');
      const vectorFile = path.join(tmpDir, 'sync-index.json');
      fs.writeFileSync(vectorFile, JSON.stringify({ records: [{
        id: 'keep.txt#23', docId: 'keep.txt', embedding: [1, 0], text: 'legacy chunk',
        meta: { filePath: keepPath },
      }] }));

      let failEmbedding = false;
      const embedding = { embed: async texts => {
        if (failEmbedding && texts.some(text => text.includes('changed'))) throw new Error('provider failure');
        return texts.map(() => [1, 0]);
      } };
      const store = new FileVectorStore(vectorFile);
      const retriever = new RetrieverService(store, {
        get: key => key === 'ai.embedding' ? { use: embedding } : undefined,
      });
      assert.strictEqual((await retriever.ingestFromDirectory(docs)).chunks, 2);
      fs.unlinkSync(oldPath);
      fs.writeFileSync(keepPath, 'changed version');
      failEmbedding = true;
      const result = await retriever.ingestFromDirectory(docs);
      assert.deepStrictEqual(result.failed, [{ docId: 'keep.txt', stage: 'embed' }]);
      const hits = await new FileVectorStore(vectorFile).query([1, 0], 10);
      assert.deepStrictEqual(hits.map(hit => [hit.docId, hit.text]), [['keep.txt', 'previous version']]);
    });

    it('ingestFromDirectory 分块向量化落地，retrieve 检索出 hits', async () => {
      const docsDir = path.join(tmpDir, 'docs');
      fs.mkdirSync(docsDir, { recursive: true });
      fs.writeFileSync(path.join(docsDir, 'guide.md'), 'agent is an agent runtime harness framework.');
      fs.writeFileSync(path.join(docsDir, 'api.txt'), 'API sign guard verifies MD5 signature.');

      const storeFile = path.join(tmpDir, 'vector-retriever.json');
      const vectorStore = new FileVectorStore(storeFile);

      // 自定义向量化 Provider
      const mockEmbedder = {
        embed: async (texts) => {
          return texts.map((t) => {
            if (t.includes('agent') || t.includes('agent')) return [1, 0];
            return [0, 1];
          });
        },
      };

      const mockConfig = {
        get: key => {
          if (key === 'ai.embedding') return { use: mockEmbedder };
          if (key === 'ai.rag') return { chunk: { size: 100, overlap: 10 }, topK: 2 };
        },
      };

      const retriever = new RetrieverService(vectorStore, mockConfig);

      const ingestRes = await retriever.ingestFromDirectory(docsDir);
      assert.strictEqual(ingestRes.ingested, 2);
      assert.strictEqual(ingestRes.chunks, 2);

      const queryRes = await retriever.retrieve('What is agent agent?');
      assert.ok(Array.isArray(queryRes.hits));
      assert.strictEqual(queryRes.hits.length, 2);
      assert.strictEqual(queryRes.hits[0].docId, 'guide.md');
      assert.strictEqual(queryRes.hits[0].text, 'agent is an agent runtime harness framework.');
      assert.strictEqual(queryRes.hits[0].score, 1);
    });

    it('内置 retrieve tool 注册成功，source 必须为 builtin，且 inputSchema 仅含 query', () => {
      const mockModuleRef = {
        get: (token) => {
          if (token.name === 'ConfigService') {
            return { get: () => undefined };
          }
          if (token.name === 'RetrieverService') {
            return {
              retrieve: async (query) => ({
                hits: [{ docId: 'test.md', text: 'hit text for ' + query, score: 0.99 }],
              }),
            };
          }
          return undefined;
        },
      };

      const registry = new ToolRegistryService(mockModuleRef);
      registry.onModuleInit();

      const retrieveToolDef = registry.get('retrieve');
      assert.ok(retrieveToolDef);
      assert.strictEqual(retrieveToolDef.source, 'builtin');
      assert.strictEqual(retrieveToolDef.description, resolveRagOptions({ get: () => undefined }).tool.description);
      assert.deepStrictEqual(retrieveToolDef.inputSchema, {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '检索关键词或自然语言提问',
          },
        },
        required: ['query'],
      });
    });
  });

  describe('RAG 管理与引用', () => {
    function deferred() {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      return { promise, resolve };
    }

    it('向量存储配置支持实例和工厂，并校验数据库驱动配置', async () => {
      const store = new FileVectorStore(path.join(tmpDir, 'configured-vector.json'));
      const configFor = options => ({ get: key => key === 'ai.store.vector' ? options : undefined });
      assert.strictEqual(await resolveVectorStore(configFor({ use: store })), store);
      const factoryConfig = configFor({ use: async config => {
        assert.strictEqual(config, factoryConfig);
        return store;
      } });
      assert.strictEqual(await resolveVectorStore(factoryConfig), store);
      await assert.rejects(resolveVectorStore(configFor({ driver: 'mysql' })), /requires a MySQL connection/);
      await assert.rejects(resolveVectorStore(configFor({ driver: 'qdrant' })), /Qdrant URL and vector dimensions/);
      await assert.rejects(resolveVectorStore(configFor({ use: {} })), /must provide a VectorStore/);
    });

    it('重建期间可读旧快照，按调用顺序提交删除，并隔离同名文档', async () => {
      const docs = path.join(tmpDir, 'snapshot-docs');
      const otherDocs = path.join(tmpDir, 'snapshot-other');
      fs.mkdirSync(docs);
      fs.mkdirSync(otherDocs);
      const doc = path.join(docs, 'policy.txt');
      fs.writeFileSync(doc, 'original text');
      fs.writeFileSync(path.join(otherDocs, 'policy.txt'), 'outside source');
      const entered = deferred();
      const release = deferred();
      let block = true;
      const embed = async texts => {
        if (block && texts[0] === '😀 new version') {
          entered.resolve();
          await release.promise;
        }
        return texts.map(() => [1, 0]);
      };
      const store = new FileVectorStore(path.join(tmpDir, 'snapshot-vector.json'));
      const retriever = new RetrieverService(store, {
        get: key => key === 'ai.embedding' ? { use: { embed } } : undefined,
      });
      await retriever.rebuild(docs);
      await retriever.rebuild(otherDocs);
      const old = (await retriever.preview(docs, 'policy')).hits[0];
      fs.writeFileSync(doc, '  😀 new version\n');
      const rebuilt = retriever.rebuild(docs);
      await entered.promise;
      const deleted = retriever.deleteDocument(docs, 'policy.txt');
      try {
        assert.deepStrictEqual((await retriever.preview(docs, 'policy')).hits.map(hit => hit.id), [old.id]);
        assert.deepStrictEqual(await retriever.listDocuments(docs), [{ docId: 'policy.txt', chunks: 1 }]);
      } finally {
        block = false;
        release.resolve();
      }
      await rebuilt;
      assert.strictEqual(await deleted, 1);
      assert.deepStrictEqual(await retriever.listDocuments(docs), []);
      assert.strictEqual((await retriever.preview(otherDocs, 'policy')).hits[0].text, 'outside source');
      const rebuiltAgain = await retriever.rebuild(docs);
      assert.deepStrictEqual(rebuiltAgain.succeeded, ['policy.txt']);
      const current = (await retriever.preview(docs, 'policy')).hits[0];
      const located = await retriever.loadChunk(docs, current.id);
      assert.notStrictEqual(current.id, old.id);
      assert.strictEqual(await retriever.loadChunk(docs, old.id), null);
      assert.strictEqual(await retriever.loadChunk(otherDocs, current.id), null);
      assert.match(located.meta.version, /^[a-f0-9]{64}$/);
      assert.strictEqual(fs.readFileSync(doc, 'utf8').slice(located.meta.start, located.meta.end), current.text);
      await retriever.rebuild(docs);
      assert.strictEqual((await retriever.preview(docs, 'policy')).hits[0].id, current.id);
    });

    it('重建区分无法读取的文件、无切片的文件和不可用的源目录', async () => {
      const docs = path.join(tmpDir, 'read-errors');
      fs.mkdirSync(docs);
      fs.writeFileSync(path.join(docs, 'a.txt'), 'old A');
      fs.writeFileSync(path.join(docs, 'b.txt'), 'old B');
      fs.writeFileSync(path.join(docs, 'c.txt'), 'old C');
      const entered = deferred();
      const release = deferred();
      const embed = async texts => {
        if (texts[0] === 'new A') {
          entered.resolve();
          await release.promise;
        }
        return texts.map(() => [1]);
      };
      const store = new FileVectorStore(path.join(tmpDir, 'read-errors-vector.json'));
      const retriever = new RetrieverService(store, {
        get: key => key === 'ai.embedding' ? { use: { embed } } : undefined,
      });
      await retriever.rebuild(docs);
      fs.writeFileSync(path.join(docs, 'a.txt'), 'new A');
      fs.writeFileSync(path.join(docs, 'c.txt'), '  \n');
      const rebuilt = retriever.rebuild(docs);
      await entered.promise;
      try {
        fs.unlinkSync(path.join(docs, 'b.txt'));
      } finally {
        release.resolve();
      }
      assert.deepStrictEqual(await rebuilt, {
        ingested: 3, chunks: 1, succeeded: ['a.txt'], skipped: ['c.txt'], failed: [{ docId: 'b.txt', stage: 'read' }],
      });
      fs.renameSync(docs, docs + '-offline');
      await assert.rejects(retriever.rebuild(docs), { code: 'ENOENT' });
      assert.deepStrictEqual((await retriever.preview(docs, 'a')).hits.map(hit => hit.text).sort(), ['new A', 'old B']);
      fs.mkdirSync(docs);
      assert.strictEqual((await retriever.rebuild(docs)).ingested, 0);
      assert.deepStrictEqual(await retriever.listDocuments(docs), []);
    });

    it('索引写入失败时保留已发布的内存索引，并可继续写入', async () => {
      const index = path.join(tmpDir, 'published-vector.json');
      const store = new FileVectorStore(index);
      const oldRecord = { id: 'old', docId: 'policy', text: 'old', embedding: [1] };
      const newRecord = { id: 'new', docId: 'policy', text: 'new', embedding: [1] };
      await store.upsert([oldRecord]);
      fs.renameSync(index, index + '.backup');
      fs.mkdirSync(index);
      await assert.rejects(store.upsert([newRecord]));
      assert.deepStrictEqual((await store.query([1], 10)).map(hit => hit.id), ['old']);
      fs.rmdirSync(index);
      fs.renameSync(index + '.backup', index);
      await store.upsert([newRecord]);
      assert.deepStrictEqual((await new FileVectorStore(index).query([1], 10)).map(hit => hit.id), ['old', 'new']);
    });

    it('引用只匹配本轮成功检索和最终 Markdown 正文，按正文顺序去重', () => {
      const { hits } = retrievalOutput(
        ['first', 'second', 'ignored', 'previous', 'failed', 'mcp'].map(id => ({
          docId: id + '.md', id, text: 'Evidence: ' + id, score: 0.5,
        })),
      );
      const [first, second, ignored, previous, failed, mcp] = hits;
      const observed = { type: 'tool', name: 'local-retrieve', source: 'builtin' };
      const steps = [
        { ...observed, output: { hits: [first, second, ignored] } },
        { ...observed, error: { code: 'FAIL' }, output: { hits: [failed] } },
        { ...observed, source: 'mcp', output: { hits: [mcp] } },
        { type: 'plan', output: ignored.citation },
      ];
      const tick = '`';
      const output = [
        '> ' + tick.repeat(3) + 'md',
        '> ' + ignored.citation,
        '> ' + tick.repeat(3),
        '',
        '    ' + ignored.citation,
        '',
        tick.repeat(2) + ' ' + ignored.citation + ' ' + tick + ' ' + tick.repeat(2),
        '\\' + ignored.citation,
        '<!-- ' + ignored.citation + ' -->',
        '示例 <code>' + ignored.citation + '</code>',
        '[链接](https://example.test/' + ignored.citation + ')',
        '',
        '乙 **' + second.citation + '**，甲 ' + first.citation,
        '重复 ' + second.citation + ' ' + previous.citation + ' ' + failed.citation + ' ' + mcp.citation,
        '伪造 [cite:111111111111111111111111]',
      ].join('\n');
      assert.deepStrictEqual(collectCitations(output, steps, 'local-retrieve').map(citation => citation.chunkId),
        ['second', 'first']);
      assert.deepStrictEqual(collectCitations(first.citation, [], 'local-retrieve'), []);
      assert.deepStrictEqual(collectCitations(first.citation, [{
        ...observed, output: { hits: [{ ...first, text: 'tampered' }] },
      }], 'local-retrieve'), []);
    });
  });
});
