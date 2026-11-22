const assert = require('node:assert/strict');
const { createHash, createHmac, randomUUID } = require('node:crypto');
const { mkdtemp, mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const { IncomingMessage, ServerResponse } = require('node:http');
const { Duplex } = require('node:stream');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { AIMessageChunk } = require('@langchain/core/messages');
const { NestFactory } = require('@nestjs/core');
const { AgentScannerService } = require('../../dist/ai/agent/agent-scanner.service');
const { agentRequestSignature } = require('../../dist/ai/access/request-signature');
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
    const docs = join(fixture, 'docs');
    const keyId = 'fixture-eval';
    const secret = 'fixture-signing-secret';
    const app = await NestFactory.create(AppModule.register({
      agentConfig: { threadEnabled: true },
      ai: {
        access: { keys: { [keyId]: { secret, agents: ['support'] } } },
        store: {
          trace: join(fixture, 'trace'),
          memory: { path: join(fixture, 'memory') },
          vector: { path: join(fixture, 'vector.json'), fixturesPath: docs },
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

  it('RAG 管理接口校验权限、直达原文切片，并与 Agent 同步、SSE 和 Trace 共享引用', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'flico-rag-api-'));
    const docs = join(fixture, 'docs');
    const docId = 'policies/refund.md';
    const source = '  Refunds within 30 days.  \n' + 'More historical information. '.repeat(6);
    const app = await NestFactory.create(AppModule.register({
      ai: {
        access: {
          authorize: req => req.headers.cookie === 'fixture-rag-session=reader'
            ? { scope: 'fixture-session', ragRead: true } : null,
          keys: {
            writer: { secret: 'fixture-writer', ingest: true },
            reader: { secret: 'fixture-reader', ragRead: true },
            agent: { secret: 'fixture-agent', agents: ['support'] },
          },
        },
        store: {
          trace: join(fixture, 'trace'),
          memory: { path: join(fixture, 'memory') },
          vector: { path: join(fixture, 'vectors.json'), fixturesPath: docs },
        },
        embedding: { use: { embed: async texts => texts.map(() => [1]) } },
        rag: { chunk: { size: 64, overlap: 0 }, topK: 10 },
        llm: { default: 'test', models: { test: { use: { async chat(messages) {
          const last = messages.at(-1);
          assert.match(messages[0].content, /答案|正文/);
          if (last.role === 'tool') {
            const { hits } = JSON.parse(last.content).output;
            const evidence = hits.find(hit => hit.docId === docId && hit.text.includes('30 days'));
            const unused = hits.find(hit => hit.docId === 'other.txt');
            return { output: '可在 30 天内退款 ' + evidence.citation + '。\n示例 `' + unused.citation + '`' };
          }
          return { output: '', message: { role: 'assistant', content: null, tool_calls: [
            { id: 'rag-lookup', type: 'function', function: { name: 'retrieve', arguments: '{"query":"refund"}' } },
          ] } };
        } } } } },
      },
    }), { logger: false, rawBody: true });

    const rag = '/api/ai/rag';
    async function signed(method, path, keyId, payload) {
      const raw = payload === undefined ? '' : JSON.stringify(payload);
      const nonce = randomUUID();
      const time = String(Date.now());
      const signature = agentRequestSignature('fixture-' + keyId, keyId, method, path, time, nonce, raw).toString('hex');
      return dispatch(app, method, path, {
        'x-agent-key-id': keyId, 'x-agent-nonce': nonce, s_t: time, s_sign: signature,
        ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
      }, raw);
    }
    const dataOf = response => JSON.parse(response.body).data;

    try {
      await app.init();
      app.get(AgentScannerService).get = name => ({ name, skills: [], tools: ['retrieve'] });
      assert.equal((await signed('POST', rag + '/rebuild', 'writer')).status, 404);
      await mkdir(join(docs, 'policies'), { recursive: true });
      const policyPath = join(docs, docId);
      await writeFile(policyPath, source);
      await writeFile(join(docs, 'other.txt'), 'Additional technical information');

      assert.equal((await dispatch(app, 'GET', rag + '/documents', {}, '')).status, 401);
      assert.equal((await signed('GET', rag + '/documents', 'agent')).status, 403);
      assert.equal((await signed('POST', rag + '/rebuild', 'reader')).status, 403);
      assert.equal((await signed('DELETE', rag + '/documents', 'reader', { docId })).status, 403);
      assert.equal((await signed('POST', rag + '/preview', 'reader', { query: ' ', topK: 1 })).status, 400);
      assert.equal((await signed('POST', rag + '/preview', 'reader', { query: 'refund', topK: '1' })).status, 400);
      assert.equal((await signed('GET', rag + '/chunk?id=one&id=two', 'reader')).status, 400);
      assert.equal((await signed('DELETE', rag + '/documents', 'writer', { docId: 1 })).status, 400);

      const rebuilt = await signed('POST', rag + '/rebuild', 'writer');
      assert.equal(rebuilt.status, 201);
      assert.deepEqual(dataOf(rebuilt).succeeded, ['other.txt', docId]);
      const listed = await signed('GET', rag + '/documents', 'reader');
      assert.equal(listed.status, 200);
      const documents = dataOf(listed);
      assert.equal(documents.length, 2);
      assert.ok(documents.find(item => item.docId === docId).chunks > 1);
      const time = String(Date.now());
      const sessionHeaders = {
        cookie: 'fixture-rag-session=reader',
        s_t: time,
        s_sign: createHash('md5').update('klx05hb3n1c9ujp8uhxbs2ikkiowp212_' + time).digest('hex'),
      };
      assert.deepEqual(dataOf(await dispatch(app, 'GET', rag + '/documents', sessionHeaders, '')), documents);
      assert.equal((await dispatch(app, 'POST', rag + '/rebuild', sessionHeaders, '')).status, 403);

      const preview = await signed('POST', rag + '/preview', 'reader', { query: 'refund' });
      assert.equal(preview.status, 201);
      const evidence = dataOf(preview).hits.find(hit => hit.docId === docId && hit.text.includes('30 days'));
      const byId = rag + '/chunk?id=' + encodeURIComponent(evidence.id);
      const chunk = await signed('GET', byId, 'reader');
      assert.equal(chunk.status, 200);
      const located = dataOf(chunk);
      assert.equal(located.citation, evidence.citation);
      assert.equal(located.meta.relativePath, docId);
      assert.equal(source.slice(located.meta.start, located.meta.end), located.text);
      assert.equal(located.meta.filePath, undefined);
      assert.equal(located.score, undefined);

      const agent = { agent: 'support', input: 'refund' };
      const sync = await signed('POST', '/api/ai/agent/run', 'agent', agent);
      assert.equal(sync.status, 201);
      const result = dataOf(sync);
      assert.deepEqual(result.citations, [{
        ref: evidence.citation, docId, chunkId: evidence.id, score: evidence.score,
      }]);
      const stream = await signed('POST', '/api/ai/agent/run/stream', 'agent', agent);
      assert.equal(stream.status, 201);
      const done = JSON.parse(stream.body.match(/event: done\r?\ndata: (.+)/)[1]).data;
      assert.deepEqual(done.citations, result.citations);

      await writeFile(policyPath, 'Refunds within 15 days.');
      assert.equal((await signed('POST', rag + '/rebuild', 'writer')).status, 201);
      assert.equal((await signed('GET', byId, 'reader')).status, 404);
      assert.equal(dataOf(await signed('GET', rag + '/documents', 'reader')).find(item => item.docId === docId).chunks, 1);
      const trace = dataOf(await signed('GET', '/api/ai/trace/' + result.runId, 'agent'));
      assert.deepEqual(trace.citations, result.citations);
      const observed = trace.steps.find(step => step.type === 'tool' && step.name === 'retrieve');
      assert.equal(observed.output.hits.find(hit => hit.id === evidence.id).text, located.text);

      const deleted = await signed('DELETE', rag + '/documents', 'writer', { docId });
      assert.equal(deleted.status, 200);
      assert.deepEqual(dataOf(deleted), { docId, removed: 1 });
      assert.equal(await readFile(policyPath, 'utf8'), 'Refunds within 15 days.');
      assert.equal((await signed('DELETE', rag + '/documents', 'writer', { docId })).status, 404);
      await signed('POST', rag + '/rebuild', 'writer');
      assert.ok(dataOf(await signed('GET', rag + '/documents', 'reader')).some(item => item.docId === docId));
    } finally {
      await app.close();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('Wiki 管理、预览和 Agent 共用已发布索引，Trace 保留换版前的原文依据', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'flico-wiki-api-'));
    const docs = join(fixture, 'docs');
    const file = join(docs, 'policy.md');
    const rag = '/api/ai/rag';
    const app = await NestFactory.create(AppModule.register({
      ai: {
        access: { keys: {
          operator: { secret: 'fixture-operator', ingest: true },
          agent: { secret: 'fixture-agent', agents: ['support'] },
        } },
        store: {
          trace: join(fixture, 'trace'),
          memory: { path: join(fixture, 'memory') },
          vector: { path: join(fixture, 'vectors.json'), fixturesPath: docs },
        },
        rag: { mode: 'hybrid', topK: 2, wiki: { model: 'compiler' } },
        embedding: { use: { embed: async texts => texts.map(() => [1]) } },
        llm: { default: 'answer', models: {
          compiler: { use: { async chat(messages) {
            const [source] = JSON.parse(messages.at(-1).content).chunks;
            return { output: JSON.stringify({ sections: [{
              pageId: 'refunds', title: '退款', heading: '处理时限',
              markdown: '摘要 ' + source.text, chunkIds: [source.id],
            }] }) };
          } } },
          answer: { use: { async chat(messages) {
            const last = messages.at(-1);
            if (last.role === 'tool') {
              const { hits } = JSON.parse(last.content).output;
              const wiki = hits.find(hit => hit.meta.kind === 'wiki');
              return { output: '根据退款规则 ' + wiki.citation };
            }
            return { output: '', message: { role: 'assistant', content: null, tool_calls: [
              { id: 'lookup', type: 'function', function: { name: 'retrieve', arguments: '{"query":"退款"}' } },
            ] } };
          } } },
        } },
      },
    }), { logger: false, rawBody: true });

    function signed(method, path, keyId, payload) {
      const raw = payload === undefined ? '' : JSON.stringify(payload);
      const nonce = randomUUID();
      const time = String(Date.now());
      const signature = agentRequestSignature('fixture-' + keyId, keyId, method, path, time, nonce, raw).toString('hex');
      return dispatch(app, method, path, {
        'x-agent-key-id': keyId, 'x-agent-nonce': nonce, s_t: time, s_sign: signature,
        ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
      }, raw);
    }
    const data = response => JSON.parse(response.body).data;

    try {
      await app.init();
      app.get(AgentScannerService).get = name => ({ name, skills: [], tools: ['retrieve'] });
      await mkdir(docs);
      await writeFile(file, '退款时限为三十天。');
      assert.equal((await signed('GET', rag + '/wiki/pages', 'agent')).status, 403);
      const built = await signed('POST', rag + '/rebuild', 'operator');
      assert.equal(built.status, 201);
      assert.deepEqual(data(built).wiki, { pages: 1, sections: 1, generatedSections: 1 });
      assert.deepEqual(data(await signed('GET', rag + '/wiki/pages', 'operator')), [
        { id: 'refunds', title: '退款', sections: 1 },
      ]);
      const fullPage = await signed('GET', rag + '/wiki/page?id=refunds', 'operator');
      assert.equal(fullPage.status, 200);
      assert.match(data(fullPage).markdown, /三十天/);

      const preview = data(await signed('POST', rag + '/preview', 'operator', { query: '退款' }));
      const wiki = preview.hits.find(hit => hit.meta.kind === 'wiki');
      assert.equal(wiki.id, data(fullPage).sections[0].chunkId);
      assert.equal(preview.hits.length, 2);
      const run = await signed('POST', '/api/ai/agent/run', 'agent', { agent: 'support', input: '退款？' });
      assert.equal(run.status, 201);
      const result = data(run);
      assert.deepEqual(result.citations, [{
        ref: wiki.citation, docId: wiki.docId, chunkId: wiki.id, score: wiki.score,
        kind: 'wiki', pageId: 'refunds',
      }]);
      assert.equal(data(await signed('GET', rag + '/chunk?id=' + wiki.id, 'operator')).meta.wiki.sources[0].text,
        '退款时限为三十天。');

      await writeFile(file, '退款时限为十五天。');
      assert.equal((await signed('POST', rag + '/rebuild', 'operator')).status, 201);
      assert.equal((await signed('GET', rag + '/chunk?id=' + wiki.id, 'operator')).status, 404);
      const trace = data(await signed('GET', '/api/ai/trace/' + result.runId, 'agent'));
      const historical = trace.steps.find(step => step.type === 'tool').output.hits.find(hit => hit.id === wiki.id);
      assert.equal(historical.meta.wiki.sources[0].text, '退款时限为三十天。');
      assert.deepEqual(trace.citations, result.citations);
    } finally {
      await app.close();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('Wiki 模式预览与 Agent 一致引用并回溯原文，删索引后重建恢复，默认使用 ai.llm.default', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'flico-wiki-mode-api-'));
    const docs = join(fixture, 'docs');
    const rag = '/api/ai/rag';
    const app = await NestFactory.create(AppModule.register({
      ai: {
        access: { keys: {
          operator: { secret: 'fixture-operator', ingest: true },
          agent: { secret: 'fixture-agent', agents: ['support'] },
        } },
        store: {
          trace: join(fixture, 'trace'),
          memory: { path: join(fixture, 'memory') },
          vector: { path: join(fixture, 'vectors.json'), fixturesPath: docs },
        },
        rag: { mode: 'wiki', topK: 2 },
        embedding: { use: { embed: async texts => texts.map(() => [1, 0]) } },
        llm: { default: 'defaultModel', models: { defaultModel: { use: { async chat(messages) {
          const last = messages.at(-1);
          if (last.role === 'tool') {
            const { hits } = JSON.parse(last.content).output;
            const cited = hits[0];
            const unused = hits[1];
            return { output: '仅引用第一条 ' + cited.citation + '，忽略示例 `' + unused.citation + '`' };
          }
          if (messages[0].role === 'system' && messages[0].content.includes('compile a durable Markdown knowledge wiki')) {
            const [source] = JSON.parse(last.content).chunks;
            const isAppeal = source.docId === 'appeal.md';
            return { output: JSON.stringify({ sections: [{
              pageId: isAppeal ? 'appeals' : 'refunds',
              title: isAppeal ? '复核流程' : '退款规则',
              heading: source.docId,
              markdown: '编译段落：' + source.text,
              chunkIds: [source.id],
              links: isAppeal ? ['refunds'] : ['appeals'],
            }] }) };
          }
          return { output: '', message: { role: 'assistant', content: null, tool_calls: [
            { id: 'lookup', type: 'function', function: { name: 'retrieve', arguments: '{"query":"退款"}' } },
          ] } };
        } } } } },
      },
    }), { logger: false, rawBody: true });

    function signed(method, path, keyId, payload) {
      const raw = payload === undefined ? '' : JSON.stringify(payload);
      const nonce = randomUUID();
      const time = String(Date.now());
      const signature = agentRequestSignature('fixture-' + keyId, keyId, method, path, time, nonce, raw).toString('hex');
      return dispatch(app, method, path, {
        'x-agent-key-id': keyId, 'x-agent-nonce': nonce, s_t: time, s_sign: signature,
        ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
      }, raw);
    }
    const data = response => JSON.parse(response.body).data;

    try {
      await app.init();
      app.get(AgentScannerService).get = name => ({ name, skills: [], tools: ['retrieve'] });
      await mkdir(docs);
      await writeFile(join(docs, 'policy.md'), '退款有效期为三十天。');
      await writeFile(join(docs, 'appeal.md'), '超时退款可申请人工复核。');

      const built = await signed('POST', rag + '/rebuild', 'operator');
      assert.equal(built.status, 201);
      assert.deepEqual(data(built).wiki, { pages: 2, sections: 2, generatedSections: 2 });

      // 预览与 Agent 同步/流式在 wiki 模式下命中同一版本证据，且多条命中只收录正文实际引用的一条
      const preview = data(await signed('POST', rag + '/preview', 'operator', { query: '退款' }));
      assert.equal(preview.hits.length, 2);
      assert.ok(preview.hits.every(hit => hit.meta.kind === 'wiki'));

      const sync = data(await signed('POST', '/api/ai/agent/run', 'agent', { agent: 'support', input: '退款' }));
      const streamed = await signed('POST', '/api/ai/agent/run/stream', 'agent', { agent: 'support', input: '退款' });
      const done = JSON.parse(streamed.body.match(/event: done\r?\ndata: (.+)/)[1]).data;
      assert.deepEqual(sync.citations, [{
        ref: preview.hits[0].citation,
        docId: preview.hits[0].docId,
        chunkId: preview.hits[0].id,
        score: preview.hits[0].score,
        kind: 'wiki',
        pageId: preview.hits[0].meta.wiki.pageId,
      }]);
      assert.deepEqual(done.citations, sync.citations);

      // 定位 Wiki 切片并进一步回溯到原文切片
      const locatedWiki = data(await signed('GET', rag + '/chunk?id=' + encodeURIComponent(sync.citations[0].chunkId), 'operator'));
      assert.equal(locatedWiki.meta.version, preview.hits[0].meta.version);
      const [sourceRef] = locatedWiki.meta.wiki.sources;
      const locatedRaw = data(await signed('GET', rag + '/chunk?id=' + encodeURIComponent(sourceRef.chunkId), 'operator'));
      assert.equal(locatedRaw.meta.version, sourceRef.version);
      assert.equal(locatedRaw.text, sourceRef.text);

      // 删除某文档索引使对应 Wiki 页面和切片退场；重建后由于源文件仍在而恢复
      const deletedDocId = sourceRef.docId;
      assert.equal((await signed('DELETE', rag + '/documents', 'operator', { docId: deletedDocId })).status, 200);
      assert.equal((await signed('GET', rag + '/chunk?id=' + encodeURIComponent(sync.citations[0].chunkId), 'operator')).status, 404);
      assert.equal((await signed('GET', rag + '/chunk?id=' + encodeURIComponent(sourceRef.chunkId), 'operator')).status, 404);
      const trace = data(await signed('GET', '/api/ai/trace/' + sync.runId, 'agent'));
      assert.deepEqual(trace.citations, sync.citations);
      assert.equal(trace.steps.find(step => step.type === 'tool').output.hits[0].meta.wiki.sources[0].text, sourceRef.text);

      const rebuilt = await signed('POST', rag + '/rebuild', 'operator');
      assert.equal(rebuilt.status, 201);
      assert.equal(data(rebuilt).wiki.generatedSections, 1);
      assert.equal((await signed('GET', rag + '/wiki/pages', 'operator')).status, 200);
      assert.equal(data(await signed('GET', rag + '/wiki/pages', 'operator')).length, 2);

      // GET /api/ai/agent/config 返回脱敏后的完整 AI/RAG/Wiki 运行配置，不泄漏密钥与本地路径
      const time = String(Date.now());
      const legacySign = createHash('md5').update('klx05hb3n1c9ujp8uhxbs2ikkiowp212_' + time).digest('hex');
      const configRes = await dispatch(app, 'GET', '/api/ai/agent/config', { s_t: time, s_sign: legacySign }, '');
      assert.equal(configRes.status, 200);
      const publicConfig = JSON.parse(configRes.body);
      assert.equal(publicConfig.threadEnabled, true);
      assert.equal(publicConfig.maxIterations, 5);
      assert.deepEqual(publicConfig.memory, { maxTurns: 20 });
      assert.deepEqual(publicConfig.llm, { default: 'defaultModel', models: ['defaultModel'] });
      assert.deepEqual(publicConfig.embedding, { default: null, models: [] });
      assert.deepEqual(publicConfig.rag, {
        mode: 'wiki',
        topK: 2,
        chunk: { size: 500, overlap: 50 },
        tool: { name: 'retrieve', description: '从私有知识库检索片段。使用片段时，在答案正文原样插入该片段的 citation 标记。' },
        wiki: { model: 'defaultModel' },
        source: { driver: 'file' },
        vector: { driver: 'file' },
      });
      assert.deepEqual(publicConfig.mcp, { enabled: false, servers: [] });
      assert.deepEqual(publicConfig.guardrail, { enabled: false });
      assert.doesNotMatch(configRes.body, /fixture-operator|fixture-agent|vectors\.json|flico-wiki-mode-api-/);
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
