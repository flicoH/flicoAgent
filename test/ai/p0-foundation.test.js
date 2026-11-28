const assert = require('node:assert/strict');
const { createHash, createHmac, randomUUID } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const { IncomingMessage, ServerResponse } = require('node:http');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Duplex } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../../dist/app.module');
const { AgentScannerService } = require('../../dist/ai/agent/agent-scanner.service');
const { SkillScannerService } = require('../../dist/ai/skill/skill-scanner.service');
const { ToolRegistryService } = require('../../dist/ai/tool/tool-registry.service');
const { LangGraphOrchestratorService } = require('../../dist/ai/runtime/langgraph/langgraph-orchestrator.service');
const { McpLoader } = require('../../dist/ai/mcp/mcp.loader');
const { McpClient } = require('../../dist/ai/mcp/mcp.client');
const { bootstrap, resolveListenPort } = require('../../dist/main');
const {
  InMemoryNonceStore,
  MysqlNonceStore,
  RedisNonceStore,
  MysqlTraceStore,
  MysqlMemoryStore,
  RedisTraceStore,
  RedisMemoryStore,
} = require('../../dist/nest-public');

function dispatch(app, method, url, headers, body) {
  return new Promise((resolve, reject) => {
    let raw = '';
    const socket = new Duplex({
      read() {},
      write(chunk, _encoding, done) { raw += chunk; done(); },
    });
    socket.remoteAddress = '127.0.0.1';
    const req = new IncomingMessage(socket);
    Object.assign(req, { method, url, headers, httpVersion: '1.1' });
    req.complete = true;
    const res = new ServerResponse(req);
    const timeout = setTimeout(() => reject(new Error('No response for ' + method + ' ' + url)), 3000);
    res.assignSocket(socket);
    res.useChunkedEncodingByDefault = false;
    res.on('error', reject);
    res.on('finish', () => {
      clearTimeout(timeout);
      resolve({ status: res.statusCode, body: raw.slice(raw.indexOf('\r\n\r\n') + 4) });
    });
    app.getHttpAdapter().getInstance()(req, res);
    req.push(body || null);
    if (body) req.push(null);
  });
}

function createFakeRedis() {
  const kv = new Map();
  const zsets = new Map();
  const isExpired = entry => entry && entry.expiresAt !== undefined && Date.now() > entry.expiresAt;
  const getEntry = key => {
    const entry = kv.get(key);
    if (!entry) return null;
    if (isExpired(entry)) {
      kv.delete(key);
      return null;
    }
    return entry;
  };
  return {
    async get(key) {
      return getEntry(key)?.value ?? null;
    },
    async set(key, value, ...args) {
      let ttlMs;
      let nx = false;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === 'PX') ttlMs = Number(args[++i]);
        if (args[i] === 'NX') nx = true;
      }
      if (nx && getEntry(key)) return null;
      kv.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : undefined });
      return 'OK';
    },
    async del(...keys) {
      let removed = 0;
      for (const k of keys) if (kv.delete(k)) removed++;
      return removed;
    },
    async eval(_script, _numKeys, key, token) {
      if (getEntry(key)?.value === token) {
        kv.delete(key);
        return 1;
      }
      return 0;
    },
    async zadd(key, score, member) {
      const set = zsets.get(key) ?? new Map();
      set.set(member, score);
      zsets.set(key, set);
      return 1;
    },
    async zrevrange(key, start, stop) {
      const set = zsets.get(key);
      if (!set) return [];
      const sorted = [...set.entries()]
        .sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))
        .map(([member]) => member);
      return sorted.slice(start, stop + 1);
    },
    async expire() { return 1; },
  };
}

function createFakeMysqlKnex() {
  const traces = new Map();
  const memories = new Map();
  const nonces = new Map();
  const locks = new Set();

  const makeBuilder = (table) => {
    const filters = [];
    let whereInFilter = null;
    let orderBys = [];
    let offsetVal = 0;
    let limitVal = Infinity;

    const matchRows = () => {
      const source = table === 'flico_ai_traces'
        ? [...traces.values()]
        : table === 'flico_ai_memory'
          ? [...memories.values()]
          : [...nonces.values()];
      return source.filter(row => {
        for (const [col, op, val] of filters) {
          if (op === '=' && row[col] !== val) return false;
          if (op === '<' && !(row[col] < val)) return false;
        }
        if (whereInFilter && !whereInFilter.values.includes(row[whereInFilter.col])) return false;
        return true;
      });
    };

    const builder = {
      where(col, opOrVal, maybeVal) {
        if (maybeVal === undefined) filters.push([col, '=', opOrVal]);
        else filters.push([col, opOrVal, maybeVal]);
        return builder;
      },
      whereIn(col, values) {
        whereInFilter = { col, values };
        return builder;
      },
      orderBy(col, dir = 'asc') {
        orderBys.push({ col, dir: dir.toLowerCase() });
        return builder;
      },
      offset(n) { offsetVal = n; return builder; },
      limit(n) { limitVal = n; return builder; },
      async first() {
        return matchRows()[0];
      },
      async select() {
        const rows = matchRows();
        if (orderBys.length) {
          rows.sort((a, b) => {
            for (const { col, dir } of orderBys) {
              const cmp = String(a[col]).localeCompare(String(b[col]));
              if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
            }
            return 0;
          });
        }
        return rows.slice(offsetVal, offsetVal + limitVal);
      },
      async insert(row) {
        if (table === 'flico_ai_nonces') {
          const pk = `${row.namespace_key}:${row.nonce_key}`;
          if (nonces.has(pk)) {
            const err = new Error('Duplicate entry');
            err.code = 'ER_DUP_ENTRY';
            err.errno = 1062;
            throw err;
          }
          nonces.set(pk, { ...row });
        }
        return [1];
      },
      async del() {
        const target = table === 'flico_ai_traces' ? traces : table === 'flico_ai_memory' ? memories : nonces;
        let removed = 0;
        for (const [pk, row] of [...target.entries()]) {
          let ok = true;
          for (const [col, op, val] of filters) {
            if (op === '=' && row[col] !== val) ok = false;
            if (op === '<' && !(row[col] < val)) ok = false;
          }
          if (ok) {
            target.delete(pk);
            removed++;
          }
        }
        return removed;
      },
    };
    return builder;
  };

  const knexFn = table => makeBuilder(table);
  knexFn.client = { dialect: 'mysql' };
  knexFn.raw = async (sql, bindings = []) => {
    if (sql.includes('INSERT INTO ??') && bindings[0] === 'flico_ai_traces') {
      const [, namespace_key, run_id, scope_key, agent, status, created_at, updated_at, payload] = bindings;
      traces.set(`${namespace_key}:${run_id}`, {
        namespace_key, run_id, scope_key, agent, status, created_at, updated_at, payload,
      });
      return [[]];
    }
    if (sql.includes('INSERT INTO ??') && bindings[0] === 'flico_ai_memory') {
      const [, namespace_key, thread_key, thread_id, updated_at, payload] = bindings;
      memories.set(`${namespace_key}:${thread_key}`, {
        namespace_key, thread_key, thread_id, updated_at, payload,
      });
      return [[]];
    }
    if (sql.startsWith('SELECT GET_LOCK')) {
      const lockName = bindings[0];
      while (locks.has(lockName)) await delay(5);
      locks.add(lockName);
      return [[{ acquired: 1 }]];
    }
    if (sql.startsWith('SELECT RELEASE_LOCK')) {
      locks.delete(bindings[0]);
      return [[{ released: 1 }]];
    }
    return [[]];
  };
  knexFn.transaction = async fn => fn(knexFn);
  return knexFn;
}

describe('P0 生产底座加固（E01–E03）', () => {
  it('E01: HTTP 异步运行、分页隔离、审批、直调 Skill、Chat 与 service-invoke 端到端闭环', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'p0-e01-'));
    const redis = createFakeRedis();
    const executedSkills = [];
    const app = await NestFactory.create(AppModule.register({
      ai: {
        access: {
          nonceStore: { driver: 'redis', namespace: 'p0-e01', client: redis },
          keys: {
            approver: { secret: 'secret-approver', scope: 's1', approve: true, skills: ['safe-skill', 'danger-skill'] },
            viewer: { secret: 'secret-viewer', scope: 's1', skills: ['safe-skill'] },
            other: { secret: 'secret-other', scope: 's2', approve: true },
          },
        },
        store: {
          trace: { driver: 'redis', namespace: 'p0-e01', client: redis },
          memory: { driver: 'redis', namespace: 'p0-e01', client: redis },
          vector: { path: join(fixture, 'vector.json') },
        },
        tools: {
          serviceInvoke: { ProjectService: ['getProjectList'] },
          serviceInvokeApproval: true,
        },
        llm: {
          default: 'mock',
          models: {
            mock: {
              use: {
                async chat(messages) {
                  const last = messages.at(-1);
                  if (last.role === 'tool') {
                    return { output: 'approved-done', usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 } };
                  }
                  if (last.content === 'run-approval') {
                    return {
                      output: '',
                      usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
                      message: {
                        role: 'assistant',
                        content: null,
                        tool_calls: [{ id: 'tc-1', type: 'function', function: { name: 'danger-skill', arguments: '{"op":"delete"}' } }],
                      },
                    };
                  }
                  return { output: 'chat-ok:' + last.content, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
                },
              },
            },
          },
        },
      },
    }), { logger: false, rawBody: true });

    const sign = (method, url, keyId, body = '') => {
      const time = String(Date.now());
      const nonce = randomUUID();
      const digest = createHash('sha256').update(body).digest('hex');
      const sig = createHmac('sha256', 'secret-' + keyId)
        .update([keyId, method.toUpperCase(), url, time, nonce, digest].join('\n'))
        .digest('hex');
      return dispatch(app, method.toUpperCase(), url, {
        'x-agent-key-id': keyId, 'x-agent-nonce': nonce, s_t: time, s_sign: sig,
        ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
      }, body);
    };

    try {
      await app.init();
      const skills = app.get(SkillScannerService);
      const safeSkill = {
        name: 'safe-skill',
        description: 'safe',
        inputSchema: { type: 'object', required: ['msg'], properties: { msg: { type: 'string' } } },
        execute: async input => ({ echoed: input.msg }),
      };
      const dangerSkill = {
        name: 'danger-skill',
        approval: 'required',
        description: 'danger',
        inputSchema: { type: 'object', required: ['op'], properties: { op: { type: 'string' } } },
        execute: async input => { executedSkills.push(input.op); return { done: input.op }; },
      };
      skills.get = name => (name === 'safe-skill' ? safeSkill : name === 'danger-skill' ? dangerSkill : undefined);
      app.get(AgentScannerService).get = name => name === 'ops'
        ? { name: 'ops', skills: ['safe-skill', 'danger-skill'], tools: ['service-invoke'] }
        : undefined;

      // 1. 内置 service-invoke 带审批标记
      const serviceInvoke = app.get(ToolRegistryService).get('service-invoke');
      assert.equal(serviceInvoke.approval, 'required');

      // 2. Chat 同步与流式
      const chatRes = await sign('POST', '/api/ai/chat', 'viewer', JSON.stringify({ message: 'hi' }));
      assert.equal(chatRes.status, 201);
      assert.equal(JSON.parse(chatRes.body).output, 'chat-ok:hi');
      const chatStreamRes = await sign('POST', '/api/ai/chat/stream', 'viewer', JSON.stringify({ message: 'hi' }));
      assert.equal(chatStreamRes.status, 201);
      assert.match(chatStreamRes.body, /event: delta/);
      assert.match(chatStreamRes.body, /event: done/);

      // 3. 直调 Skill：正常、Schema 校验 400、白名单 403、审批能力 403 不可绕过
      const okInvoke = await sign('POST', '/api/ai/skill/safe-skill/invoke', 'viewer', JSON.stringify({ msg: 'ok' }));
      assert.equal(okInvoke.status, 201);
      assert.deepEqual(JSON.parse(okInvoke.body).data, { echoed: 'ok' });
      assert.equal((await sign('POST', '/api/ai/skill/safe-skill/invoke', 'viewer', JSON.stringify({ msg: 123 }))).status, 400);
      assert.equal((await sign('POST', '/api/ai/skill/danger-skill/invoke', 'viewer', JSON.stringify({ op: 'x' }))).status, 403);
      assert.equal((await sign('POST', '/api/ai/skill/danger-skill/invoke', 'approver', JSON.stringify({ op: 'x' }))).status, 403);
      assert.deepEqual(executedSkills, []);

      // 4. 异步提交 -> 等待审批 -> 权限/跨 scope 校验 -> 批准 -> 成功 -> SSE 重放
      const submitted = await sign('POST', '/api/ai/agent/runs', 'approver', JSON.stringify({ agent: 'ops', input: 'run-approval' }));
      assert.equal(submitted.status, 202);
      const { runId } = JSON.parse(submitted.body).data;

      let detail;
      for (let i = 0; i < 60; i++) {
        const res = await sign('GET', `/api/ai/agent/runs/${runId}`, 'approver');
        detail = JSON.parse(res.body).data;
        if (detail.status === 'waiting_approval') break;
        await delay(10);
      }
      assert.equal(detail.status, 'waiting_approval');
      assert.equal(detail.approval.name, 'danger-skill');
      assert.deepEqual(executedSkills, []);

      // 跨 scope 不可见、无 approve 权限返回 403
      assert.equal((await sign('GET', `/api/ai/agent/runs/${runId}`, 'other')).status, 404);
      const noApprove = await sign('POST', `/api/ai/agent/runs/${runId}/approval`, 'viewer', JSON.stringify({
        approvalId: detail.approval.id, approved: true,
      }));
      assert.equal(noApprove.status, 403);

      // 批准并等待成功
      const approved = await sign('POST', `/api/ai/agent/runs/${runId}/approval`, 'approver', JSON.stringify({
        approvalId: detail.approval.id, approved: true,
      }));
      assert.equal(approved.status, 202);

      for (let i = 0; i < 60; i++) {
        const res = await sign('GET', `/api/ai/agent/runs/${runId}`, 'approver');
        detail = JSON.parse(res.body).data;
        if (detail.status === 'succeeded') break;
        await delay(10);
      }
      assert.equal(detail.status, 'succeeded');
      assert.equal(detail.output, 'approved-done');
      assert.deepEqual(executedSkills, ['delete']);

      // 已终态重放 SSE（after 过滤）与列表隔离
      const replay = await sign('GET', `/api/ai/agent/runs/${runId}/events?after=1`, 'approver');
      assert.equal(replay.status, 200);
      assert.match(replay.body, /event: start/);
      assert.match(replay.body, /event: done/);

      const listS1 = JSON.parse((await sign('GET', '/api/ai/agent/runs?limit=10&offset=0', 'approver')).body).data;
      const listS2 = JSON.parse((await sign('GET', '/api/ai/agent/runs?limit=10&offset=0', 'other')).body).data;
      assert.equal(listS1.items.length, 1);
      assert.equal(listS2.items.length, 0);
    } finally {
      await app.close();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('E02: 端口解析遵循 options > config > env > 8080 且拒绝非法端口', () => {
    assert.equal(resolveListenPort(9000, 7000, '6000'), 9000);
    assert.equal(resolveListenPort(undefined, 7000, '6000'), 7000);
    assert.equal(resolveListenPort(undefined, undefined, '6000'), 6000);
    assert.equal(resolveListenPort(undefined, undefined, undefined), 8080);
    assert.throws(() => resolveListenPort(undefined, 'not-a-port', undefined), /Invalid server port/);
    assert.throws(() => resolveListenPort(70000, undefined, undefined), /Invalid server port/);
  });

  it('E03: MySQL 与 Redis Trace/Memory/Nonce 存储支持命名空间隔离、跨实例锁与防重放', async () => {
    // 1. InMemoryNonceStore
    const memNonce = new InMemoryNonceStore();
    assert.equal(memNonce.consume('k1', 1000), true);
    assert.equal(memNonce.consume('k1', 1000), false);

    // 2. RedisTraceStore / RedisMemoryStore / RedisNonceStore
    const redis = createFakeRedis();
    const rTraceA = new RedisTraceStore(redis, { namespace: 'ns-a' });
    const rTraceB = new RedisTraceStore(redis, { namespace: 'ns-b' });
    await rTraceA.save({
      runId: 'r1', agent: 'support', input: 'q', output: 'a', steps: [], threadId: 't1',
      scope: 'tenant-1', status: 'succeeded', createdAt: '2026-01-01T00:00:01.000Z', updatedAt: '2026-01-01T00:00:01.000Z',
    });
    await rTraceA.save({
      runId: 'r2', agent: 'admin', input: 'q', output: 'a', steps: [], threadId: 't1',
      scope: 'tenant-1', status: 'succeeded', createdAt: '2026-01-01T00:00:02.000Z', updatedAt: '2026-01-01T00:00:02.000Z',
    });
    assert.equal(await rTraceB.load('r1'), null);
    assert.deepEqual(
      (await rTraceA.list({ scope: 'tenant-1', agents: ['support'], offset: 0, limit: 10 })).map(r => r.runId),
      ['r1'],
    );

    const rMem = new RedisMemoryStore(redis, { namespace: 'ns-a' });
    const order = [];
    await Promise.all([
      rMem.runTurn('shared-thread', async () => {
        order.push('start-1');
        await delay(25);
        order.push('end-1');
      }),
      rMem.runTurn('shared-thread', async () => {
        order.push('start-2');
        order.push('end-2');
      }),
    ]);
    assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2']);

    const rNonce = new RedisNonceStore(redis, { namespace: 'ns-a' });
    assert.equal(await rNonce.consume('n1', 5000), true);
    assert.equal(await rNonce.consume('n1', 5000), false);

    // 3. MysqlTraceStore / MysqlMemoryStore / MysqlNonceStore
    const fakeMysql = createFakeMysqlKnex();
    const mTrace = new MysqlTraceStore(fakeMysql, 'prod');
    await mTrace.save({
      runId: 'm1', agent: 'support', input: 'q', output: 'a', steps: [], threadId: 't1',
      scope: 'tenant-1', status: 'succeeded', createdAt: '2026-01-01T00:00:01.000Z', updatedAt: '2026-01-01T00:00:01.000Z',
    });
    assert.equal((await mTrace.load('m1')).output, 'a');
    assert.equal((await mTrace.list({ scope: 'tenant-1', agents: ['support'], offset: 0, limit: 5 })).length, 1);

    const mMem = new MysqlMemoryStore(fakeMysql, 'prod');
    const mysqlOrder = [];
    await Promise.all([
      mMem.runTurn('thread-x', async () => {
        mysqlOrder.push('a1');
        await delay(20);
        mysqlOrder.push('a2');
      }),
      mMem.runTurn('thread-x', async () => {
        mysqlOrder.push('b1');
        mysqlOrder.push('b2');
      }),
    ]);
    assert.deepEqual(mysqlOrder, ['a1', 'a2', 'b1', 'b2']);
    await mMem.save({ threadId: 'thread-x', messages: [{ role: 'user', content: 'hi' }], updatedAt: 1 });
    assert.equal((await mMem.load('thread-x')).messages[0].content, 'hi');
    await mMem.delete('thread-x');
    assert.equal(await mMem.load('thread-x'), null);

    const mNonce = new MysqlNonceStore(fakeMysql, 'prod');
    assert.equal(await mNonce.consume('mn-1', 5000), true);
    assert.equal(await mNonce.consume('mn-1', 5000), false);
  });

  it('E01+E03 真实多实例场景: Pod A/B 共享存储实现跨实例防重放、审批恢复与并发线程串行', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'p0-multi-pod-'));
    const sharedRedis = createFakeRedis();
    const seenHistories = [];
    const executed = [];

    const createPod = async (podName) => {
      const app = await NestFactory.create(AppModule.register({
        agentConfig: { threadEnabled: true },
        ai: {
          access: {
            nonceStore: { driver: 'redis', namespace: 'cluster-1', client: sharedRedis },
            keys: {
              ops: { secret: 'cluster-secret', scope: 'team-x', approve: true },
            },
          },
          store: {
            trace: { driver: 'redis', namespace: 'cluster-1', client: sharedRedis },
            memory: { driver: 'redis', namespace: 'cluster-1', client: sharedRedis },
            vector: { path: join(fixture, `${podName}-vector.json`) },
          },
          llm: {
            default: 'mock',
            models: {
              mock: {
                use: {
                  async chat(messages) {
                    const last = messages.at(-1);
                    if (last.role === 'tool') {
                      return { output: `resumed-on-${podName}` };
                    }
                    if (last.content === 'need-approval') {
                      return {
                        output: '',
                        message: {
                          role: 'assistant',
                          content: null,
                          tool_calls: [{ id: 'tc-pod', type: 'function', function: { name: 'deploy', arguments: '{"env":"prod"}' } }],
                        },
                      };
                    }
                    if (last.content === 'turn-1') {
                      seenHistories.push({ pod: podName, contents: messages.map(m => m.content) });
                      await delay(30);
                      return { output: 'ack-1' };
                    }
                    seenHistories.push({ pod: podName, contents: messages.map(m => m.content) });
                    return { output: 'ack-2' };
                  },
                },
              },
            },
          },
        },
      }), { logger: false, rawBody: true });
      await app.init();
      const deploySkill = {
        name: 'deploy',
        approval: 'required',
        description: 'deploy',
        inputSchema: { type: 'object', required: ['env'], properties: { env: { type: 'string' } } },
        execute: async input => { executed.push(`${podName}:${input.env}`); return { ok: true }; },
      };
      app.get(SkillScannerService).get = name => (name === 'deploy' ? deploySkill : undefined);
      app.get(AgentScannerService).get = name => (name === 'deployer' ? { name: 'deployer', skills: ['deploy'], tools: [] } : undefined);
      return app;
    };

    const makeSignedHeaders = (method, url, body, nonce = randomUUID()) => {
      const time = String(Date.now());
      const digest = createHash('sha256').update(body).digest('hex');
      const sig = createHmac('sha256', 'cluster-secret')
        .update(['ops', method.toUpperCase(), url, time, nonce, digest].join('\n'))
        .digest('hex');
      return {
        'x-agent-key-id': 'ops',
        'x-agent-nonce': nonce,
        s_t: time,
        s_sign: sig,
        ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
      };
    };

    const podA = await createPod('podA');
    const podB = await createPod('podB');
    try {
      // 1. 跨实例 Nonce 防重放：Pod A 消费后发往 Pod B 必须 401
      const sharedNonce = randomUUID();
      const listUrl = '/api/ai/agent/runs?limit=5&offset=0';
      const headers = makeSignedHeaders('GET', listUrl, '', sharedNonce);
      assert.equal((await dispatch(podA, 'GET', listUrl, headers, '')).status, 200);
      assert.equal((await dispatch(podB, 'GET', listUrl, headers, '')).status, 401);

      // 2. 跨实例审批恢复：Pod A 提交并挂起，Pod B 查询、批准并恢复完成
      const submitBody = JSON.stringify({ agent: 'deployer', input: 'need-approval' });
      const submitted = await dispatch(podA, 'POST', '/api/ai/agent/runs', makeSignedHeaders('POST', '/api/ai/agent/runs', submitBody), submitBody);
      assert.equal(submitted.status, 202);
      const { runId } = JSON.parse(submitted.body).data;

      let pausedOnB;
      for (let i = 0; i < 60; i++) {
        const url = `/api/ai/agent/runs/${runId}`;
        const res = await dispatch(podB, 'GET', url, makeSignedHeaders('GET', url, ''), '');
        pausedOnB = JSON.parse(res.body).data;
        if (pausedOnB.status === 'waiting_approval') break;
        await delay(10);
      }
      assert.equal(pausedOnB.status, 'waiting_approval');
      assert.equal(pausedOnB.approval.name, 'deploy');

      const approveUrl = `/api/ai/agent/runs/${runId}/approval`;
      const approveBody = JSON.stringify({ approvalId: pausedOnB.approval.id, approved: true });
      const approvedRes = await dispatch(podB, 'POST', approveUrl, makeSignedHeaders('POST', approveUrl, approveBody), approveBody);
      assert.equal(approvedRes.status, 202);

      let doneOnA;
      for (let i = 0; i < 60; i++) {
        const url = `/api/ai/agent/runs/${runId}`;
        const res = await dispatch(podA, 'GET', url, makeSignedHeaders('GET', url, ''), '');
        doneOnA = JSON.parse(res.body).data;
        if (doneOnA.status === 'succeeded') break;
        await delay(10);
      }
      assert.equal(doneOnA.status, 'succeeded');
      assert.equal(doneOnA.output, 'resumed-on-podB');
      assert.deepEqual(executed, ['podB:prod']);

      // 3. 跨实例同线程并发串行：Pod A 与 Pod B 同时请求同一 threadId，不丢失上下文
      const t1Body = JSON.stringify({ agent: 'deployer', input: 'turn-1', threadId: 'cluster-thread' });
      const t2Body = JSON.stringify({ agent: 'deployer', input: 'turn-2', threadId: 'cluster-thread' });
      const p1 = dispatch(podA, 'POST', '/api/ai/agent/run', makeSignedHeaders('POST', '/api/ai/agent/run', t1Body), t1Body);
      await delay(5);
      const p2 = dispatch(podB, 'POST', '/api/ai/agent/run', makeSignedHeaders('POST', '/api/ai/agent/run', t2Body), t2Body);
      const [r1, r2] = await Promise.all([p1, p2]);
      assert.equal(r1.status, 201);
      assert.equal(r2.status, 201);
      assert.deepEqual(seenHistories[0].contents, ['turn-1']);
      assert.deepEqual(seenHistories[1].contents, ['turn-1', 'ack-1', 'turn-2']);
    } finally {
      await podA.close();
      await podB.close();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('E01 边界场景: 连续审批 SSE 推送、终态 409、队列 429、service-invoke 容器调用与 MCP approvalTools', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'p0-edge-'));
    const app = await NestFactory.create(AppModule.register({
      ai: {
        store: {
          trace: join(fixture, 'trace'),
          memory: { path: join(fixture, 'memory') },
          vector: { path: join(fixture, 'vector.json') },
        },
        tools: {
          serviceInvoke: { ProjectService: ['getList'] },
        },
        llm: {
          default: 'mock',
          models: {
            mock: {
              use: {
                async chat(messages, options) {
                  const last = messages.at(-1);
                  if (last.role === 'tool') return { output: 'all-checked' };
                  if (last.content === 'two-approvals') {
                    return {
                      output: '',
                      message: {
                        role: 'assistant',
                        content: null,
                        tool_calls: [
                          { id: 'c1', type: 'function', function: { name: 'step-a', arguments: '{}' } },
                          { id: 'c2', type: 'function', function: { name: 'step-b', arguments: '{}' } },
                        ],
                      },
                    };
                  }
                  await delay(5_000, undefined, { signal: options?.signal });
                  return { output: 'slow' };
                },
              },
            },
          },
        },
      },
    }), { logger: false });

    try {
      await app.init();
      const mkApprovalSkill = name => ({
        name, approval: 'required', description: name, inputSchema: { type: 'object' },
        execute: async () => ({ ok: name }),
      });
      app.get(SkillScannerService).get = name => (name === 'step-a' || name === 'step-b' ? mkApprovalSkill(name) : undefined);
      app.get(AgentScannerService).get = name => (name === 'multi' ? { name: 'multi', skills: ['step-a', 'step-b'], tools: [] } : undefined);

      // 1. 连续两次审批时的实时 SSE 通知 + 终态取消 409
      const orchestrator = app.get(LangGraphOrchestratorService);
      const summary = await orchestrator.submit('multi', 'two-approvals', undefined, { scope: 's1' });
      const events = [];
      const unsubscribe = await orchestrator.subscribe(summary.runId, 0, { scope: 's1' }, evt => events.push(evt));

      const waitStatus = async (status, minApprovalCount = 0) => {
        for (let i = 0; i < 80; i++) {
          const run = await orchestrator.find(summary.runId, { scope: 's1' });
          const approvals = run.steps.filter(s => s.type === 'approval').length;
          if (run.status === status && approvals >= minApprovalCount) return run;
          await delay(10);
        }
        assert.fail(`Timeout waiting for ${status}`);
      };

      const firstWait = await waitStatus('waiting_approval', 0);
      await orchestrator.decide(summary.runId, firstWait.approval.id, true, { scope: 's1', approve: true });
      const secondWait = await waitStatus('waiting_approval', 1);
      assert.equal(secondWait.approval.name, 'step-b');
      await orchestrator.decide(summary.runId, secondWait.approval.id, false, { scope: 's1', approve: true });
      const finished = await waitStatus('succeeded', 2);
      unsubscribe();
      assert.equal(finished.output, 'all-checked');
      assert.ok(events.filter(e => e.event === 'status' && e.data.status === 'waiting_approval').length >= 2);
      assert.ok(events.some(e => e.event === 'done'));
      await assert.rejects(orchestrator.cancel(summary.runId, { scope: 's1' }), { status: 409 });

      // 2. service-invoke 真实按类名调用 Nest 容器中的 ProjectService.getList，并拦截未白名单方法
      const serviceInvoke = app.get(ToolRegistryService).get('service-invoke');
      const list = await serviceInvoke.execute({ service: 'ProjectService', method: 'getList', args: [{}] });
      assert.ok(Array.isArray(list));
      await assert.rejects(
        serviceInvoke.execute({ service: 'ProjectService', method: 'get', args: ['x'] }),
        /not allowed/,
      );

      // 3. MCP approvalTools 适配审批标记
      const origConnect = McpClient.prototype.connect;
      const origList = McpClient.prototype.listTools;
      const origClose = McpClient.prototype.close;
      McpClient.prototype.connect = async () => undefined;
      McpClient.prototype.listTools = async () => [
        { name: 'read_item', description: 'read', inputSchema: {} },
        { name: 'drop_table', description: 'drop', inputSchema: {} },
      ];
      McpClient.prototype.close = async () => undefined;
      try {
        const loader = new McpLoader({
          get: key => key === 'ai.mcp'
            ? { enabled: true, servers: [{ name: 'db', url: 'http://127.0.0.1:9999', approvalTools: ['drop_table'] }] }
            : undefined,
        });
        const tools = await loader.load();
        assert.equal(tools.find(t => t.name === 'read_item').approval, undefined);
        assert.equal(tools.find(t => t.name === 'drop_table').approval, 'required');
        await loader.closeAll();
      } finally {
        McpClient.prototype.connect = origConnect;
        McpClient.prototype.listTools = origList;
        McpClient.prototype.close = origClose;
      }

      // 4. 队列容量上限 100 校验（第 101 个提交返回 429）
      const submittedIds = [];
      for (let i = 0; i < 100; i++) {
        const s = await orchestrator.submit('multi', 'slow-' + i, undefined, { scope: 'q' });
        submittedIds.push(s.runId);
      }
      await assert.rejects(
        orchestrator.submit('multi', 'overflow', undefined, { scope: 'q' }),
        { status: 429 },
      );
      for (const id of submittedIds) {
        await orchestrator.cancel(id, { scope: 'q' }).catch(() => undefined);
      }
      await delay(30);
    } finally {
      await app.close();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('E02 真实启动契约: bootstrap 支持自定义 port/host 与 enableShutdownHooks 优雅停机', async () => {
    const originalCreate = NestFactory.create;
    let shutdownEnabled = false;
    let listenedPort;
    let listenedHost;
    const mockApp = {
      getHttpAdapter: () => ({ getInstance: () => ({ use: () => undefined }) }),
      useGlobalPipes: () => undefined,
      useGlobalInterceptors: () => undefined,
      enableShutdownHooks: () => { shutdownEnabled = true; },
      get: () => ({ get: key => (key === 'port' ? 9091 : key === 'host' ? '127.0.0.1' : undefined) }),
      listen: async (port, host) => { listenedPort = port; listenedHost = host; },
    };
    NestFactory.create = async () => mockApp;
    try {
      await bootstrap({});
      assert.equal(shutdownEnabled, true);
      assert.equal(listenedPort, 9091);
      assert.equal(listenedHost, '127.0.0.1');

      shutdownEnabled = false;
      await bootstrap({ port: 9092, host: '0.0.0.0', shutdownHooks: false });
      assert.equal(shutdownEnabled, false);
      assert.equal(listenedPort, 9092);
      assert.equal(listenedHost, '0.0.0.0');
    } finally {
      NestFactory.create = originalCreate;
    }
  });
});
