const assert = require('node:assert/strict');
const { createHash, createHmac } = require('node:crypto');
const { IncomingMessage, ServerResponse } = require('node:http');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Duplex } = require('node:stream');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../../dist/app.module');
const { AgentScannerService } = require('../../dist/ai/agent/agent-scanner.service');
const { CheckpointService } = require('../../dist/ai/memory/checkpoint.service');
const {
  resolveMemoryMaxContextTokens,
  resolveMemorySummarizationOptions,
} = require('../../dist/ai/memory/internal/load-memory-config');
const {
  computeScopedCheckpointId,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTextTokens,
  trimMessagesToTokenBudget,
} = require('../../dist/ai/memory/internal/token-budget');
const { ThreadService } = require('../../dist/ai/memory/thread.service');
const { FileMemoryStore } = require('../../dist/ai/store/reference/file-memory.store');
const { MysqlMemoryStore } = require('../../dist/ai/store/reference/mysql-memory.store');
const { RedisMemoryStore } = require('../../dist/ai/store/reference/redis-store');
const { LangGraphOrchestratorService } = require('../../dist/ai/runtime/langgraph/langgraph-orchestrator.service');
const { ExecutorService } = require('../../dist/ai/tool/executor.service');
const { TraceService } = require('../../dist/ai/trace/trace.service');

function makeMockConfig(map = {}) {
  return {
    get(key) {
      if (Object.prototype.hasOwnProperty.call(map, key)) {
        return map[key];
      }
      const parts = String(key).split('.');
      let cur = map;
      for (const part of parts) {
        if (cur && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, part)) {
          cur = cur[part];
        } else {
          return undefined;
        }
      }
      return cur;
    },
  };
}

function dispatch(app, method, url, headers = {}, body = '') {
  return new Promise((resolve, reject) => {
    let raw = '';
    const socket = new Duplex({
      read() {},
      write(chunk, _enc, cb) {
        raw += chunk;
        cb();
      },
    });
    socket.remoteAddress = '127.0.0.1';
    const req = new IncomingMessage(socket);
    Object.assign(req, {
      method,
      url,
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)])),
      httpVersion: '1.1',
      rawBody: Buffer.from(body),
    });
    req.complete = true;

    const res = new ServerResponse(req);
    const timeout = setTimeout(() => reject(new Error(`No response for ${method} ${url}`)), 3000);
    res.assignSocket(socket);
    res.useChunkedEncodingByDefault = false;
    res.on('error', reject);
    res.on('finish', () => {
      clearTimeout(timeout);
      const sep = raw.indexOf('\r\n\r\n');
      resolve({ status: res.statusCode, body: sep === -1 ? raw : raw.slice(sep + 4) });
    });

    app.getHttpAdapter().getInstance()(req, res);
    req.push(body || null);
    if (body) req.push(null);
  });
}

function createSignedHeaders(keyId, secret, method, path, body = '') {
  const timestamp = String(Date.now());
  const nonce = `n-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const canonical = `${keyId}\n${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
  const signature = createHmac('sha256', secret).update(canonical).digest('hex');
  return {
    'x-agent-key-id': keyId,
    'x-agent-nonce': nonce,
    s_t: timestamp,
    s_sign: signature,
    ...(body ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } : {}),
  };
}

function createFakeRedisClient() {
  const kv = new Map();
  const zsets = new Map();
  return {
    async get(key) {
      return kv.has(key) ? kv.get(key) : null;
    },
    async set(key, value) {
      kv.set(key, value);
      return 'OK';
    },
    async del(...keys) {
      for (const k of keys) kv.delete(k);
      return keys.length;
    },
    async zadd(key, score, member) {
      if (!zsets.has(key)) zsets.set(key, new Map());
      zsets.get(key).set(member, score);
      return 1;
    },
    async zrevrange(key, start, stop) {
      const map = zsets.get(key);
      if (!map) return [];
      const sorted = [...map.entries()].sort((a, b) => b[1] - a[1]).map(entry => entry[0]);
      return sorted.slice(start, stop + 1);
    },
    async zrem(key, ...members) {
      const map = zsets.get(key);
      if (!map) return 0;
      let removed = 0;
      for (const m of members) {
        if (map.delete(m)) removed++;
      }
      return removed;
    },
    async expire() {
      return 1;
    },
  };
}

describe('E07: Token 预算裁剪、历史摘要压缩与线程管理 API', () => {
  describe('1. Token 估算、预算裁剪与配置解析', () => {
    it('estimateTextTokens 与 trimMessagesToTokenBudget 按预算裁剪并剥离孤立 assistant 开头', () => {
      assert.equal(estimateTextTokens(''), 0);
      assert.ok(estimateTextTokens('hello world') >= 3);
      assert.ok(estimateTextTokens('这是一段中文上下文约束说明') >= 10);

      const messages = [
        { role: 'user', content: 'A'.repeat(120) },
        { role: 'assistant', content: 'B'.repeat(120) },
        { role: 'user', content: 'C'.repeat(80) },
        { role: 'assistant', content: 'D'.repeat(80) },
      ];

      // 预算刚好容纳后 3 条，但第 2 条是孤立 assistant，应自动剥离使其以 user 开头
      const costLastTwo = estimateMessagesTokens(messages.slice(2));
      const costAssistant2 = estimateMessageTokens(messages[1]);
      const trimmed = trimMessagesToTokenBudget(messages, costLastTwo + costAssistant2);
      assert.equal(trimmed.kept.length, 2);
      assert.equal(trimmed.kept[0].role, 'user');
      assert.equal(trimmed.kept[0].content, 'C'.repeat(80));
      assert.equal(trimmed.dropped.length, 2);

      // 极小预算下保底保留最新 1 条，避免上下文全空
      const tiny = trimMessagesToTokenBudget(messages, 5);
      assert.equal(tiny.kept.length, 1);
      assert.equal(tiny.kept[0].content, 'D'.repeat(80));
    });

    it('resolveMemoryMaxContextTokens 与 resolveMemorySummarizationOptions 解析优先级与兜底正确', () => {
      assert.equal(resolveMemoryMaxContextTokens(makeMockConfig({})), undefined);
      assert.equal(resolveMemoryMaxContextTokens(makeMockConfig({ 'ai.memory.maxContextTokens': 1500 })), 1500);
      assert.equal(resolveMemoryMaxContextTokens(makeMockConfig({
        'ai.store.memory.maxContextTokens': 2400,
        'ai.memory.maxContextTokens': 1500,
      })), 2400);
      assert.equal(resolveMemoryMaxContextTokens(makeMockConfig({ 'ai.store.memory.maxContextTokens': -10 })), undefined);

      const defaultSum = resolveMemorySummarizationOptions(makeMockConfig({}));
      assert.equal(defaultSum.enabled, false);
      assert.equal(defaultSum.triggerTokens, 4000);
      assert.equal(defaultSum.keepRecentMessages, 6);
      assert.equal(defaultSum.maxSummaryChars, 2000);

      const customSum = resolveMemorySummarizationOptions(makeMockConfig({
        ai: {
          store: {
            memory: {
              maxContextTokens: 1800,
              summarization: {
                enabled: true,
                model: 'fast-model',
                keepRecentMessages: 1, // 最小钳制为 2
                maxSummaryChars: 500,
              },
            },
          },
        },
      }));
      assert.equal(customSum.enabled, true);
      assert.equal(customSum.model, 'fast-model');
      assert.equal(customSum.triggerTokens, 1800, '未配 triggerTokens 时默认继承 maxContextTokens');
      assert.equal(customSum.keepRecentMessages, 2);
      assert.equal(customSum.maxSummaryChars, 500);
    });
  });

  describe('2. ThreadService 摘要注入、增量压缩与失败降级', () => {
    it('buildContextMessages 前置注入 summary 系统消息并先扣除摘要 Token 预算', () => {
      const cfg = makeMockConfig({
        'ai.store.memory': {
          maxTurns: 20,
          maxContextTokens: 85,
        },
      });
      const threadService = new ThreadService(cfg);
      const checkpoint = {
        threadId: 't-budget',
        summary: '用户硬性约束：只返回 JSON 格式。',
        messages: [
          { role: 'user', content: '第一轮问题：' + '内容'.repeat(30) },
          { role: 'assistant', content: '第一轮答复：' + '答复'.repeat(30) },
          { role: 'user', content: '最新提问' },
          { role: 'assistant', content: '最新回答' },
        ],
        updatedAt: Date.now(),
      };

      const ctx = threadService.buildContextMessages(checkpoint);
      assert.equal(ctx[0].role, 'system');
      assert.match(ctx[0].content, /只返回 JSON 格式/);
      assert.equal(ctx[ctx.length - 1].content, '最新回答');
      assert.ok(ctx.length < 5, '较早的超预算消息应被裁剪');
    });

    it('compressCheckpoint 触发增量摘要压缩，异常时优雅降级为标准滑窗截断', async () => {
      const cfg = makeMockConfig({
        'ai.store.memory': {
          maxTurns: 4,
          summarization: {
            enabled: true,
            model: 'sum-model',
            triggerTokens: 50,
            keepRecentMessages: 2,
            maxSummaryChars: 80,
          },
        },
      });
      const threadService = new ThreadService(cfg);
      const base = {
        threadId: 't-sum',
        summary: '早期约束：代号 ALPHA',
        summarizedCount: 2,
        messages: [
          { role: 'user', content: '请保持输出简洁' },
          { role: 'assistant', content: '好的，将保持简洁。' },
          { role: 'user', content: '继续分析订单 #1001' },
          { role: 'assistant', content: '订单 #1001 状态正常。' },
        ],
        updatedAt: 1000,
      };

      let receivedModel = null;
      let receivedPrompt = '';
      const compressed = await threadService.compressCheckpoint(base, async (msgs, opts) => {
        receivedModel = opts.model;
        receivedPrompt = msgs[1].content;
        return '合并摘要：代号 ALPHA；保持简洁；已处理前半段对话。'.repeat(4);
      });

      assert.equal(receivedModel, 'sum-model');
      assert.match(receivedPrompt, /代号 ALPHA/);
      assert.match(receivedPrompt, /请保持输出简洁/);
      assert.equal(compressed.messages.length, 2);
      assert.equal(compressed.messages[0].content, '继续分析订单 #1001');
      assert.equal(compressed.summarizedCount, 4);
      assert.ok(compressed.summary.length <= 80, '摘要长度应受 maxSummaryChars 上限约束');

      // 摘要模型报错时优雅降级，保留旧摘要并按 maxTurns 截断，不抛出异常
      const degraded = await threadService.compressCheckpoint(
        {
          ...base,
          messages: [
            ...base.messages,
            { role: 'user', content: '第三轮' },
            { role: 'assistant', content: '第三轮答复' },
          ],
        },
        async () => { throw new Error('summary llm 503'); },
      );
      assert.equal(degraded.summary, '早期约束：代号 ALPHA');
      assert.equal(degraded.summarizedCount, 2);
      assert.equal(degraded.messages.length, 4);
    });
  });

  describe('3. File / MySQL / Redis 三套 MemoryStore 驱动按 scope 分页 list', () => {
    it('FileMemoryStore.list 按 scope 严格隔离并按 updatedAt 倒序分页', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'e07-file-mem-'));
      try {
        const store = new FileMemoryStore(dir);
        await store.save({ threadId: 'a1', publicThreadId: 't1', scope: 'scope-a', messages: [], updatedAt: 100 });
        await store.save({ threadId: 'a2', publicThreadId: 't2', scope: 'scope-a', messages: [], updatedAt: 300 });
        await store.save({ threadId: 'a3', publicThreadId: 't3', scope: 'scope-a', messages: [], updatedAt: 200 });
        await store.save({ threadId: 'b1', publicThreadId: 't1', scope: 'scope-b', messages: [], updatedAt: 500 });
        await store.save({ threadId: 'g1', messages: [], updatedAt: 400 });

        const page1 = await store.list({ scope: 'scope-a', offset: 0, limit: 2 });
        assert.deepEqual(page1.map(c => c.publicThreadId), ['t2', 't3']);

        const page2 = await store.list({ scope: 'scope-a', offset: 2, limit: 2 });
        assert.deepEqual(page2.map(c => c.publicThreadId), ['t1']);

        const scopeB = await store.list({ scope: 'scope-b', offset: 0, limit: 10 });
        assert.deepEqual(scopeB.map(c => c.publicThreadId), ['t1']);

        const unscoped = await store.list({ scope: undefined, offset: 0, limit: 10 });
        assert.deepEqual(unscoped.map(c => c.threadId), ['g1']);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('MysqlMemoryStore.list 按 namespace 与 scope 过滤并倒序分页', async () => {
      const storedRows = [];
      const mockDb = table => ({
        where(col, val) {
          this._filters = [...(this._filters || []), [col, val]];
          return this;
        },
        orderBy(col, dir) {
          this._order = [col, dir];
          return this;
        },
        async select() {
          const nsFilter = this._filters.find(([c]) => c === 'namespace_key');
          return storedRows
            .filter(r => !nsFilter || r.namespace_key === nsFilter[1])
            .sort((a, b) => b.updated_at - a.updated_at);
        },
      });
      mockDb.raw = async (_sql, params) => {
        const [, nsKey, threadKey, threadId, updatedAt, payload] = params;
        const idx = storedRows.findIndex(r => r.namespace_key === nsKey && r.thread_key === threadKey);
        const row = { namespace_key: nsKey, thread_key: threadKey, thread_id: threadId, updated_at: updatedAt, payload };
        if (idx >= 0) storedRows[idx] = row;
        else storedRows.push(row);
      };

      const store = new MysqlMemoryStore(mockDb, 'prod');
      await store.save({ threadId: 'k1', publicThreadId: 't1', scope: 's1', messages: [], updatedAt: 10 });
      await store.save({ threadId: 'k2', publicThreadId: 't2', scope: 's1', messages: [], updatedAt: 30 });
      await store.save({ threadId: 'k3', publicThreadId: 't3', scope: 's2', messages: [], updatedAt: 50 });

      const listed = await store.list({ scope: 's1', offset: 0, limit: 10 });
      assert.deepEqual(listed.map(c => c.publicThreadId), ['t2', 't1']);
    });

    it('RedisMemoryStore 维护按 scope 隔离的 ZSET 索引，支持 list 与 delete 同步清理', async () => {
      const client = createFakeRedisClient();
      const store = new RedisMemoryStore(client, { namespace: 'e07' });
      await store.save({ threadId: 'rk1', publicThreadId: 't1', scope: 'sa', messages: [], updatedAt: 100 });
      await store.save({ threadId: 'rk2', publicThreadId: 't2', scope: 'sa', messages: [], updatedAt: 200 });
      await store.save({ threadId: 'rk3', publicThreadId: 't1', scope: 'sb', messages: [], updatedAt: 300 });

      const listA = await store.list({ scope: 'sa', offset: 0, limit: 10 });
      assert.deepEqual(listA.map(c => c.publicThreadId), ['t2', 't1']);

      await store.delete('rk2');
      const afterDelete = await store.list({ scope: 'sa', offset: 0, limit: 10 });
      assert.deepEqual(afterDelete.map(c => c.publicThreadId), ['t1']);

      const listB = await store.list({ scope: 'sb', offset: 0, limit: 10 });
      assert.deepEqual(listB.map(c => c.publicThreadId), ['t1']);
    });
  });

  describe('4. 长会话自动摘要压缩：不丢早期约束（Orchestrator 集成）', () => {
    it('多轮对话超阈值后自动压缩早期历史并在下轮将早期约束注入上下文', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'e07-orch-'));
      try {
        const config = makeMockConfig({
          'agentConfig.threadEnabled': true,
          'ai.store.memory': {
            maxTurns: 4,
            maxContextTokens: 400,
            summarization: {
              enabled: true,
              triggerTokens: 20,
              keepRecentMessages: 2,
              maxSummaryChars: 500,
            },
          },
        });
        const memoryStore = new FileMemoryStore(dir);
        const checkpointService = new CheckpointService(memoryStore);
        const threadService = new ThreadService(config);
        const runs = new Map();
        const trace = new TraceService({
          save: async run => { runs.set(run.runId, structuredClone(run)); },
          load: async id => (runs.has(id) ? structuredClone(runs.get(id)) : null),
        });
        const agents = { get: name => (name === 'assistant' ? { name: 'assistant', skills: [], tools: [] } : undefined) };
        const skills = { get: () => undefined };
        const tools = { get: () => undefined };

        const seenContextHistory = [];
        let summaryCalls = 0;
        const planner = {
          async plan(messages) {
            seenContextHistory.push(messages.map(m => ({ role: m.role, content: m.content })));
            const last = messages[messages.length - 1].content;
            return { finalAnswer: `收到：${last}` };
          },
          async chat(messages) {
            summaryCalls++;
            const userPrompt = messages[messages.length - 1].content;
            const hasConstraint = userPrompt.includes('PHOENIX-9');
            return {
              output: hasConstraint
                ? '关键约束：所有回答必须牢记项目代号 PHOENIX-9。'
                : '常规历史摘要。',
            };
          },
        };

        const orchestrator = new LangGraphOrchestratorService(
          agents, skills, tools, planner, new ExecutorService(skills, tools, config),
          trace, threadService, checkpointService, { check: () => ({ safe: true }) }, config,
        );

        await orchestrator.run('assistant', '记住约束：项目代号是 PHOENIX-9', undefined, 'long-thread', { scope: 's1' });
        await orchestrator.run('assistant', '第二轮：确认需求范围与交付物清单', undefined, 'long-thread', { scope: 's1' });
        await orchestrator.run('assistant', '第三轮：项目代号是什么？', undefined, 'long-thread', { scope: 's1' });

        assert.ok(summaryCalls >= 1, '应触发历史摘要压缩');
        const turn3Messages = seenContextHistory[2];
        const summaryMsg = turn3Messages.find(m => m.role === 'system' && m.content.includes('PHOENIX-9'));
        assert.ok(summaryMsg, '第三轮模型上下文应包含由早期第一轮压缩保留下来的 PHOENIX-9 约束摘要');

        const key = computeScopedCheckpointId('s1', 'long-thread');
        const saved = await checkpointService.load(key);
        assert.equal(saved.publicThreadId, 'long-thread');
        assert.equal(saved.scope, 's1');
        assert.equal(saved.agent, 'assistant');
        assert.ok(saved.summary && saved.summary.includes('PHOENIX-9'));
        assert.ok(saved.summarizedCount >= 2);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('5. NestJS HTTP 端到端集成（/api/ai/threads 全套管理接口、scope 隔离与 /agent/config）', () => {
    it('列表/详情/重命名/清空/删除、跨 scope 404 隔离与脱敏 config 端到端闭环', async () => {
      const fixture = await mkdtemp(join(tmpdir(), 'e07-http-'));
      const secretA = 'e07-secret-a';
      const secretB = 'e07-secret-b';

      const app = await NestFactory.create(AppModule.register({
        agentConfig: { threadEnabled: true },
        ai: {
          store: {
            trace: join(fixture, 'trace'),
            memory: {
              path: join(fixture, 'memory'),
              maxTurns: 4,
              maxContextTokens: 1200,
              summarization: {
                enabled: true,
                triggerTokens: 25,
                keepRecentMessages: 2,
                maxSummaryChars: 500,
              },
            },
            vector: { path: join(fixture, 'vector.json') },
          },
          access: {
            keys: {
              tenantA: { secret: secretA, scope: 'tenant-a', agents: ['helper'] },
              tenantB: { secret: secretB, scope: 'tenant-b', agents: ['helper'] },
            },
          },
          llm: {
            default: 'mock',
            models: {
              mock: {
                use: {
                  async chat(messages) {
                    const isSummary = messages[0] && messages[0].role === 'system'
                      && messages[0].content.includes('对话记忆压缩器');
                    if (isSummary) {
                      return { output: '摘要：保留约束 RULE-42' };
                    }
                    const last = messages[messages.length - 1].content;
                    return { output: `reply:${last}` };
                  },
                },
              },
            },
          },
        },
      }), { logger: false, rawBody: true });

      try {
        await app.init();
        app.get(AgentScannerService).get = name => (name === 'helper'
          ? { name: 'helper', skills: [], tools: [] }
          : undefined);

        const reqAs = (keyId, secret, method, path, bodyObj) => {
          const body = bodyObj !== undefined ? JSON.stringify(bodyObj) : '';
          return dispatch(app, method, path, createSignedHeaders(keyId, secret, method, path, body), body);
        };

        // 1) tenantA 在 thread-1 跑两轮（触发摘要压缩），在 thread-2 跑一轮；tenantB 也在 thread-1 跑一轮
        assert.equal((await reqAs('tenantA', secretA, 'POST', '/api/ai/agent/run', {
          agent: 'helper', input: '第一轮建立约束 RULE-42，详细说明业务目标', threadId: 'thread-1',
        })).status, 201);
        assert.equal((await reqAs('tenantA', secretA, 'POST', '/api/ai/agent/run', {
          agent: 'helper', input: '第二轮补充细节与验收条件说明', threadId: 'thread-1',
        })).status, 201);
        assert.equal((await reqAs('tenantA', secretA, 'POST', '/api/ai/agent/run', {
          agent: 'helper', input: '另一条独立线程', threadId: 'thread-2',
        })).status, 201);
        assert.equal((await reqAs('tenantB', secretB, 'POST', '/api/ai/agent/run', {
          agent: 'helper', input: '租户 B 的同名线程', threadId: 'thread-1',
        })).status, 201);

        // 2) GET /api/ai/threads 按 scope 列出，仅见本租户线程且不暴露内部 hash 键
        const listA = await reqAs('tenantA', secretA, 'GET', '/api/ai/threads?limit=10&offset=0');
        assert.equal(listA.status, 200);
        const listAData = JSON.parse(listA.body).data;
        assert.deepEqual(listAData.items.map(item => item.threadId), ['thread-2', 'thread-1']);
        assert.doesNotMatch(listA.body, /agent-scope-/);

        const t1Summary = listAData.items.find(item => item.threadId === 'thread-1');
        assert.equal(t1Summary.hasSummary, true);
        assert.ok(t1Summary.summarizedCount >= 2);
        assert.equal(t1Summary.agent, 'helper');
        assert.ok(t1Summary.estimatedTokens > 0);

        // 3) GET /api/ai/threads/:threadId 详情与跨 scope 404 隔离
        const detailA = await reqAs('tenantA', secretA, 'GET', '/api/ai/threads/thread-1');
        assert.equal(detailA.status, 200);
        const detailAData = JSON.parse(detailA.body).data;
        assert.equal(detailAData.threadId, 'thread-1');
        assert.equal(detailAData.summary, '摘要：保留约束 RULE-42');
        assert.equal(detailAData.messages.length, 2);

        const crossGet = await reqAs('tenantB', secretB, 'GET', '/api/ai/threads/thread-2');
        assert.equal(crossGet.status, 404);

        // 4) PATCH /api/ai/threads/:threadId 重命名与非法标题 400
        const badPatch = await reqAs('tenantA', secretA, 'PATCH', '/api/ai/threads/thread-1', { title: '   ' });
        assert.equal(badPatch.status, 400);

        const okPatch = await reqAs('tenantA', secretA, 'PATCH', '/api/ai/threads/thread-1', { title: '订单需求分析' });
        assert.equal(okPatch.status, 200);
        assert.equal(JSON.parse(okPatch.body).data.title, '订单需求分析');

        // 5) POST /api/ai/threads/:threadId/clear 清空消息与摘要但保留标题
        const clearRes = await reqAs('tenantA', secretA, 'POST', '/api/ai/threads/thread-1/clear');
        assert.equal(clearRes.status, 200);
        const clearedData = JSON.parse(clearRes.body).data;
        assert.equal(clearedData.title, '订单需求分析');
        assert.equal(clearedData.messageCount, 0);
        assert.equal(clearedData.hasSummary, false);
        assert.equal(clearedData.summarizedCount, 0);

        // 6) DELETE /api/ai/threads/:threadId 删除 tenantA 的 thread-1，不影响 tenantB 同名 thread-1
        const delA = await reqAs('tenantA', secretA, 'DELETE', '/api/ai/threads/thread-1');
        assert.equal(delA.status, 200);
        assert.deepEqual(JSON.parse(delA.body).data, { threadId: 'thread-1', deleted: true });
        assert.equal((await reqAs('tenantA', secretA, 'GET', '/api/ai/threads/thread-1')).status, 404);

        const stillB = await reqAs('tenantB', secretB, 'GET', '/api/ai/threads/thread-1');
        assert.equal(stillB.status, 200);
        assert.equal(JSON.parse(stillB.body).data.messages[0].content, '租户 B 的同名线程');

        // 7) GET /api/ai/agent/config 脱敏展示 maxContextTokens 与 summarization 配置
        const time = String(Date.now());
        const legacySign = createHash('md5').update(`klx05hb3n1c9ujp8uhxbs2ikkiowp212_${time}`).digest('hex');
        const cfgRes = await dispatch(app, 'GET', '/api/ai/agent/config', { s_t: time, s_sign: legacySign }, '');
        assert.equal(cfgRes.status, 200);
        const cfg = JSON.parse(cfgRes.body);
        assert.equal(cfg.memory.maxTurns, 4);
        assert.equal(cfg.memory.maxContextTokens, 1200);
        assert.deepEqual(cfg.memory.summarization, {
          enabled: true,
          triggerTokens: 25,
          keepRecentMessages: 2,
          maxSummaryChars: 500,
        });
      } finally {
        await app.close();
        await rm(fixture, { recursive: true, force: true });
      }
    });
  });
});
