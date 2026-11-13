const assert = require('assert');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { resolveEmbeddingProvider } = require('../../dist/ai/embedding/internal/load-embedding-config');
const { EmbeddingGateway } = require('../../dist/ai/embedding/embedding.gateway');
const { DashScopeCompatibleEmbeddingProvider } = require('../../dist/ai/embedding/providers/dashscope-compatible');
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

  describe('1, 2, 3, 4, 5: EmbeddingGateway & Provider', () => {
    it('503 后重试，并在耗尽尝试次数时保留上游诊断标识', async () => {
      const originalPost = axios.post;
      let calls = 0;
      axios.post = async () => {
        calls += 1;
        const error = new Error('Request failed with status code 503');
        error.response = { status: 503, headers: { 'x-request-id': 'request-123' }, data: { error: { code: 'ServiceUnavailable' } } };
        throw error;
      };
      try {
        const provider = new DashScopeCompatibleEmbeddingProvider({
          baseURL: 'https://example.com', model: 'test', apiKey: 'secret', maxRetries: 2,
        });
        await assert.rejects(provider.embed(['test']), /after 2 attempts: HTTP 503, code=ServiceUnavailable, request_id=request-123/);
        assert.strictEqual(calls, 2);
      } finally {
        axios.post = originalPost;
      }
    });

    it('resolveEmbeddingProvider 抛错当 ai.embedding 未配置或 apiKey 为占位符', () => {
      assert.throws(
        () => resolveEmbeddingProvider({ get: () => undefined }),
        /ai\.embedding is not configured/,
      );

      assert.throws(
        () => resolveEmbeddingProvider({
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

    it('resolveEmbeddingProvider 支持 use: 注入自定义 Provider', async () => {
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

      const provider = resolveEmbeddingProvider(configService);
      const res = await provider.embed(['test']);
      assert.deepStrictEqual(res, [[0.1, 0.2, 0.3]]);
    });

    it('EmbeddingGateway 调用 embed 空数组直接返回 []', async () => {
      const gateway = new EmbeddingGateway({ get: () => ({ use: { embed: async () => [] } }) });
      const res = await gateway.embed([]);
      assert.deepStrictEqual(res, []);
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
    it('ingestFromDirectory 分块向量化落地，retrieve 检索出 hits', async () => {
      const docsDir = path.join(tmpDir, 'docs');
      fs.mkdirSync(docsDir, { recursive: true });
      fs.writeFileSync(path.join(docsDir, 'guide.md'), 'agent is an agent runtime harness framework.');
      fs.writeFileSync(path.join(docsDir, 'api.txt'), 'API sign guard verifies MD5 signature.');

      const storeFile = path.join(tmpDir, 'vector-retriever.json');
      const vectorStore = new FileVectorStore(storeFile);

      // Mock EmbeddingGateway
      const mockEmbeddingGateway = {
        embed: async (texts) => {
          return texts.map((t) => {
            if (t.includes('agent') || t.includes('agent')) return [1, 0];
            return [0, 1];
          });
        },
      };

      const mockConfig = {
        get: (key) => ({
          chunk: { size: 100, overlap: 10 },
          topK: 2,
        }),
      };

      const retriever = new RetrieverService(vectorStore, mockEmbeddingGateway, mockConfig);

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
