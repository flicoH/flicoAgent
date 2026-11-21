const assert = require('node:assert/strict');
const { createHash, createHmac, randomUUID } = require('node:crypto');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { IncomingMessage, ServerResponse } = require('node:http');
const { Duplex } = require('node:stream');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { AIMessageChunk } = require('@langchain/core/messages');
const { NestFactory } = require('@nestjs/core');
const { AgentScannerService } = require('../../dist/ai/agent/agent-scanner.service');
const { createAgentGraph } = require('../../dist/ai/runtime/langgraph/agent.graph');
const { LangChainPlannerService } = require('../../dist/ai/runtime/langchain/langchain-planner.service');
const { LangGraphOrchestratorService } = require('../../dist/ai/runtime/langgraph/langgraph-orchestrator.service');
const { ExecutorService } = require('../../dist/ai/tool/executor.service');
const { CheckpointService } = require('../../dist/ai/memory/checkpoint.service');
const { ThreadService } = require('../../dist/ai/memory/thread.service');
const { RetrieverService } = require('../../dist/ai/rag/retriever.service');
const { parseSuite, runSuite } = require('@flicoh/agent/eval');
const { TraceService } = require('../../dist/ai/trace/trace.service');
const { AppModule } = require('../../dist/app.module');
const { RequestValidationPipe } = require('../../dist/common/validation/request-validation.pipe');

// 通过真实 Express/Nest 请求处理器验证 HTTP 合同，使用内存连接模拟网络 I/O。
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
    const timeout = setTimeout(() => reject(new Error('No response for ' + method + ' ' + url)), 500);
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

describe('AI API 权限与执行回归', () => {
  it('离线评测使用真实同步接口检查工具、引用、权限与记忆', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'flico-eval-'));
    const keyId = 'fixture-eval';
    const secret = 'fixture-signing-secret';
    const app = await NestFactory.create(AppModule.register({
      agentConfig: { threadEnabled: true },
      ai: {
        access: { keys: { [keyId]: { secret, agents: ['support'] } } },
        store: {
          trace: join(fixture, 'trace'),
          memory: { path: join(fixture, 'memory') },
          vector: { path: join(fixture, 'vector.json') },
        },
        embedding: { use: { embed: async texts => texts.map(() => [1]) } },
        llm: { default: 'test', models: { test: { use: { async chat(messages) {
          const last = messages.at(-1);
          if (last.role === 'tool') {
            const { citation } = JSON.parse(last.content).output.hits[0];
            return { output: `30 days ${citation} [cite:111111111111111111111111]` };
          }
          if (last.content === 'refund') {
            return { output: '', message: { role: 'assistant', content: null, tool_calls: [
              { id: 'retrieve-refund', type: 'function', function: { name: 'retrieve', arguments: '{"query":"refund"}' } },
            ] } };
          }
          if (last.content === 'recall') {
            return { output: messages.find(message => message.content === 'store cedar-17') ? 'cedar-17' : 'unknown' };
          }
          return { output: 'stored' };
        } } } } },
      },
    }), { logger: false, rawBody: true });

    try {
      await app.init();
      app.get(AgentScannerService).get = name => ({ name, skills: [], tools: name === 'support' ? ['retrieve'] : [] });
      const docs = join(fixture, 'docs');
      await mkdir(docs);
      await writeFile(join(docs, 'policy.md'), 'Refunds within 30 days');
      await app.get(RetrieverService).ingestFromDirectory(docs);
      const suite = parseSuite({ cases: [
        { id: 'rag', agent: 'support', turns: [
          { input: 'refund', assert: { toolsUsed: ['retrieve'], citationDocIds: ['policy.md'] } },
        ] },
        { id: 'memory', agent: 'support', turns: [
          { input: 'store cedar-17' }, { input: 'recall', assert: { outputContains: 'cedar-17' } },
        ] },
        { id: 'permissions', agent: 'admin', turns: [{ input: 'refund', expectStatus: 403 }] },
      ] });

      const path = '/api/ai/agent/run';
      let firstRequest;
      const report = await runSuite(suite, async request => {
        const raw = JSON.stringify(request);
        const time = String(Date.now());
        const nonce = randomUUID();
        const digest = createHash('sha256').update(raw).digest('hex');
        const signature = createHmac('sha256', secret).update([keyId, 'POST', path, time, nonce, digest].join('\n')).digest('hex');
        const headers = { 'x-agent-key-id': keyId, 'x-agent-nonce': nonce, s_t: time, s_sign: signature,
          'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) };
        firstRequest ??= { headers, raw };
        const result = await dispatch(app, 'POST', path, headers, raw);
        return { status: result.status, body: JSON.parse(result.body) };
      });
      assert.equal(report.passed, 3, JSON.stringify(report));
      assert.equal(report.cases[2].turns[0].httpStatus, 403);
      assert.doesNotMatch(JSON.stringify(report), /cedar-17|Refunds within|fixture-signing-secret/);
      const trace = await app.get(TraceService).load(report.cases[0].turns[0].runId);
      assert.deepEqual(trace.citations.map(citation => citation.docId), ['policy.md']);
      assert.equal((await dispatch(app, 'POST', path, firstRequest.headers, firstRequest.raw)).status, 401);
    } finally {
      await app.close();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('按 Agent 白名单和 Schema 执行，逐一回填同轮所有 tool_call ID', async () => {
    const schema = { type: 'object', required: ['item'], properties: { item: { type: 'string' } } };
    const executed = [];
    const calls = [
      { id: 'a', name: 'permitted', args: { item: 'one' } },
      { id: 'b', name: 'permitted', args: { item: 123 } },
      { id: 'c', name: 'private', args: { item: 'secret' } },
    ];
    const tools = { get: name => ({
      name, inputSchema: schema, execute: async input => { executed.push(input.item); return input.item; },
    }) };
    const observed = [];
    const planner = { async plan(messages) {
      if (!messages.length) return { toolCalls: calls, response: { role: 'assistant', content: null }, usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } };
      observed.push(...messages.filter(message => message.role === 'tool'));
      return { finalAnswer: 'done', usage: { inputTokens: 7, outputTokens: 1, totalTokens: 8 } };
    } };
    const graph = createAgentGraph({
      executor: new ExecutorService({ get: () => undefined }, tools),
      planner,
      allowed: { skills: [], tools: ['permitted'] },
    });

    const state = await graph.invoke({ messages: [], tools: [], steps: [], iteration: 0, maxIterations: 3 });
    assert.deepEqual(state.steps.flatMap(step => step.usage ? [step.usage.totalTokens] : []), [8, 8]);
    assert.deepEqual(executed, ['one']);
    assert.deepEqual(observed.map(message => message.tool_call_id), ['a', 'b', 'c']);
    assert.equal(JSON.parse(observed[1].content).error.code, 'INVALID_CAPABILITY_INPUT');
    assert.equal(JSON.parse(observed[2].content).error.code, 'CAPABILITY_NOT_ALLOWED');
  });

  it('在模型结束前推送增量，并清除后来转为工具调用的临时文本', async () => {
    const planner = new LangChainPlannerService({ get: key => key === 'ai.llm' ? {
      default: 'test',
      models: { test: { provider: 'openai-compatible', baseURL: 'http://localhost', model: 'test', apiKey: 'mock' } },
    } : undefined });
    const received = [];
    // 第二块到来前先检查首块已经发出，防止退回生成完成后再切分的实现。
    planner.bindTools = () => ({ async *stream() {
      yield new AIMessageChunk({ content: '我先查询' });
      assert.deepEqual(received, ['我先查询']);
      yield new AIMessageChunk({
        content: '',
        tool_call_chunks: [{ type: 'tool_call_chunk', id: 'id', name: 'find', args: '{}', index: 0 }],
      });
    } });
    const result = await planner.plan([], [], {
      onDelta: content => received.push(content),
      resetDelta: () => received.push('reset'),
    });
    assert.deepEqual(received, ['我先查询', 'reset']);
    assert.equal(result.toolCalls[0].id, 'id');
  });

  it('同一会话轮次串行提交，相同 threadId 在不同 scope 中各自保存', async () => {
    const checkpoints = new Map();
    const store = {
      save: async state => checkpoints.set(state.threadId, structuredClone(state)),
      load: async id => checkpoints.get(id) ?? null,
    };
    const traces = new Map();
    const trace = new TraceService({
      save: async run => traces.set(run.runId, structuredClone(run)),
      load: async id => traces.get(id) ?? null,
    });
    const config = { get: key => key === 'agentConfig.threadEnabled' ? true : undefined };
    const skillRegistry = { get: () => undefined };
    const toolRegistry = { get: () => undefined };
    const histories = [];
    const orchestrator = new LangGraphOrchestratorService(
      { get: name => ({ name, skills: [], tools: [] }) }, skillRegistry, toolRegistry,
      { plan: async messages => {
        histories.push(messages.map(message => message.content));
        return { finalAnswer: 'answer', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
      } },
      new ExecutorService(skillRegistry, toolRegistry), trace, new ThreadService(config),
      new CheckpointService(store), { check: () => ({ safe: true }) }, config,
    );

    const [first, second] = await Promise.all([
      orchestrator.run('demo', 'first', undefined, 'same-thread', { scope: 'project-a' }),
      orchestrator.run('demo', 'second', undefined, 'same-thread', { scope: 'project-a' }),
    ]);
    await orchestrator.run('demo', 'third', undefined, 'same-thread', { scope: 'project-b' });
    assert.deepEqual(histories, [['first'], ['first', 'answer', 'second'], ['third']]);
    assert.equal(first.threadId, second.threadId);
    assert.equal(checkpoints.size, 2);
    assert.equal(traces.get(first.runId).scope, 'project-a');
    assert.deepEqual(first.usage, { inputTokens: 3, outputTokens: 2, totalTokens: 5 });
    assert.deepEqual(traces.get(first.runId).usage, first.usage);
  });

  it('HTTP 层校验请求体签名、重放、Trace 归属、DTO 和 Agent SSE', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'agent-http-'));
    const legacySign = time => createHash('md5').update('klx05hb3n1c9ujp8uhxbs2ikkiowp212_' + time).digest('hex');
    const traceRecords = new Map([['owned', { runId: 'owned', scope: 'scope-a', output: 'private' }]]);
    const app = await NestFactory.create(AppModule.register({
      ai: {
        access: {
          authorize: req => req.headers.cookie === 'fixture-session=valid' ? { scope: 'scope-a' } : null,
          keys: {
            a: { secret: 'local-test-key-a', scope: 'scope-a', ingest: true, approve: true },
            c: { secret: 'local-test-key-c', scope: 'scope-a' },
            b: { secret: 'local-test-key-b', scope: 'scope-b', agents: [] },
          },
        },
        store: {
          trace: { use: () => ({
            save: async run => traceRecords.set(run.runId, structuredClone(run)),
            load: async id => traceRecords.get(id) ?? null,
            list: async ({ scope, agents, offset, limit }) => [...traceRecords.values()]
              .filter(record => record.runId !== 'owned' && record.scope === scope && (!agents || agents.includes(record.agent)))
              .slice(offset, offset + limit),
          }) },
          memory: { path: join(fixture, 'memory') },
          vector: { path: join(fixture, 'vectors.json') },
        },
        embedding: { use: { embed: async values => values.map(() => [1]) } },
        llm: {
          default: 'fixture',
          models: { fixture: { use: { chat: async () => { throw new Error('local upstream failure'); } } } },
        },
      },
    }), { logger: false, rawBody: true });
    app.useGlobalPipes(new RequestValidationPipe());
    try {
      await app.init();
      app.get(AgentScannerService).get = name => name === 'fixture' ? { name, skills: [], tools: [] } : undefined;
      app.get(LangChainPlannerService).plan = async (_messages, _tools, options) => {
        await options.onDelta?.('answer');
        return { finalAnswer: 'answer', planner: 'langchain', usage: { inputTokens: 6, outputTokens: 1, totalTokens: 7 } };
      };
      function signed(method, url, keyId = 'a', body = '', signatureBody = body, nonce = randomUUID()) {
        const time = String(Date.now());
        const digest = createHash('sha256').update(signatureBody).digest('hex');
        const signature = createHmac('sha256', 'local-test-key-' + keyId)
          .update([keyId, method.toUpperCase(), url, time, nonce, digest].join('\n')).digest('hex');
        return dispatch(app, method.toUpperCase(), url, {
          'x-agent-key-id': keyId, 'x-agent-nonce': nonce, s_t: time, s_sign: signature,
          ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
        }, body);
      }
      const nonce = randomUUID();
      const traceUrl = '/api/ai/trace/owned';
      const owned = await signed('get', traceUrl, 'a', '', '', nonce);
      assert.equal(owned.status, 200);
      assert.equal(JSON.parse(owned.body).data.output, 'private');
      assert.equal(JSON.parse(owned.body).data.scope, undefined);
      assert.equal((await signed('get', traceUrl, 'a', '', '', nonce)).status, 401);
      assert.equal(JSON.parse((await signed('get', traceUrl, 'b')).body).code, 40402);
      assert.equal(JSON.parse((await signed('get', '/api/ai/trace/latest')).body).code, 40402);

      const time = String(Date.now());
      const legacy = { s_t: time, s_sign: legacySign(time) };
      assert.equal((await dispatch(app, 'GET', '/API/AI/trace/owned', legacy)).status, 401);
      const session = await dispatch(app, 'GET', traceUrl, { ...legacy, cookie: 'fixture-session=valid' });
      assert.equal(JSON.parse(session.body).data.runId, 'owned');

      const runUrl = '/api/ai/agent/run';
      const runBody = '{"agent":"fixture","input":"test","threadId":"shared-thread"}';
      assert.equal((await signed('post', runUrl, 'b', runBody)).status, 403);
      assert.equal((await signed('post', runUrl, 'a', runBody, runBody.replace('test', 'other'))).status, 401);
      assert.equal((await signed('post', runUrl, 'a', '{"agent":"fixture","threadId":7}')).status, 400);
      const sync = JSON.parse((await signed('post', runUrl, 'a', runBody)).body).data;
      const streamed = await signed('post', runUrl + '/stream', 'a', runBody);
      const matchEvent = name => JSON.parse(streamed.body.match(new RegExp('event: ' + name + '\\ndata: (.+)'))[1]);
      const start = matchEvent('start');
      const done = matchEvent('done').data;
      assert.equal(done.runId, start.runId);
      assert.equal(done.threadId, sync.threadId);
      assert.equal(done.output, sync.output);
      assert.deepEqual(done.usage, sync.usage);
      assert.equal(done.usage.totalTokens, 7);
      assert.deepEqual(done.steps.map(step => step.type), sync.steps.map(step => step.type));
      assert.equal(matchEvent('delta').content, 'answer');
      assert.equal(streamed.body.match(/event: delta\n/g).length, 1);


    } finally {
      await app.close();
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
