const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { resolveEmbedder } = require('../../dist/ai/rag/internal/load-embedding-config');
const { FileVectorStore } = require('../../dist/ai/store/reference/file-vector.store');
const { resolveRagFixturesPath, resolveRagOptions } = require('../../dist/ai/rag/internal/load-rag-config');
const { chunk, resolveChunker } = require('../../dist/ai/rag/chunker');
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
      assert.strictEqual(opts.tool.description, '从私有知识库检索相关片段；回答必须引用返回的 docId/text');
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
      assert.strictEqual(retrieveToolDef.description, '从私有知识库检索相关片段；回答必须引用返回的 docId/text');
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
});
