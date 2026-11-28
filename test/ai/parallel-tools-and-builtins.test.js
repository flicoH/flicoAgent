const assert = require('node:assert/strict');
const { createHash, createHmac } = require('node:crypto');
const { IncomingMessage, ServerResponse } = require('node:http');
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Duplex } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../../dist/app.module');
const { AgentScannerService } = require('../../dist/ai/agent/agent-scanner.service');
const { SkillScannerService } = require('../../dist/ai/skill/skill-scanner.service');
const {
  CapabilityTimeoutError,
  ExecutorService,
} = require('../../dist/ai/tool/executor.service');
const { ToolRegistryService } = require('../../dist/ai/tool/tool-registry.service');
const { truncateToolOutput } = require('../../dist/ai/tool/internal/tool-guard');
const {
  isHostAllowed,
  isPrivateIpAddress,
} = require('../../dist/ai/tool/builtin/http-request.tool');
const createHttpRequestTool = require('../../dist/ai/tool/builtin/http-request.tool').default;
const { validateReadOnlySql } = require('../../dist/ai/tool/builtin/sql-query.tool');
const createSqlQueryTool = require('../../dist/ai/tool/builtin/sql-query.tool').default;
const { evaluateMathExpression } = require('../../dist/ai/tool/builtin/calculator.tool');
const createCalculatorTool = require('../../dist/ai/tool/builtin/calculator.tool').default;
const { resolveToolConcurrency } = require('../../dist/ai/runtime/internal/load-runtime-config');
const { createAgentGraph } = require('../../dist/ai/runtime/langgraph/agent.graph');
const { LangGraphOrchestratorService } = require('../../dist/ai/runtime/langgraph/langgraph-orchestrator.service');
const { ThreadService } = require('../../dist/ai/memory/thread.service');
const { TraceService } = require('../../dist/ai/trace/trace.service');
const { ConfigService } = require('../../dist/config/config.service');
const { DatabaseProvider } = require('../../dist/extend/database.provider');

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

describe('E06: 并行工具调用、超时截断护栏与内置通用工具包', () => {
  describe('1. 运行时并发配置与 AgentScannerService 校验', () => {
    it('resolveToolConcurrency 正确解析正整数与字符串，并在非法值时回退默认 4', () => {
      assert.equal(resolveToolConcurrency(undefined), 4);
      assert.equal(resolveToolConcurrency(makeMockConfig({})), 4);
      assert.equal(resolveToolConcurrency(makeMockConfig({ 'ai.runtime.toolConcurrency': 2 })), 2);
      assert.equal(resolveToolConcurrency(makeMockConfig({ 'ai.runtime.toolConcurrency': ' 6 ' })), 6);
      assert.equal(resolveToolConcurrency(makeMockConfig({ 'ai.runtime.toolConcurrency': 0 })), 4);
      assert.equal(resolveToolConcurrency(makeMockConfig({ 'ai.runtime.toolConcurrency': -3 })), 4);
      assert.equal(resolveToolConcurrency(makeMockConfig({ 'ai.runtime.toolConcurrency': 'invalid' })), 4);
    });

    it('AgentScannerService 校验 AgentDefinition.toolConcurrency 合法性', async () => {
      const fixture = await mkdtemp(join(tmpdir(), 'e06-scanner-'));
      const agentsDir = join(fixture, 'dist', 'agents');
      await mkdir(agentsDir, { recursive: true });
      const prevCwd = process.cwd();

      try {
        await writeFile(
          join(agentsDir, 'good.agent.js'),
          'module.exports = { default: { name: "good-parallel", skills: [], tools: [], toolConcurrency: 3 } };',
        );
        process.chdir(fixture);
        const scanner = new AgentScannerService();
        scanner.onModuleInit();
        assert.equal(scanner.get('good-parallel').toolConcurrency, 3);

        await writeFile(
          join(agentsDir, 'bad.agent.js'),
          'module.exports = { default: { name: "bad-parallel", skills: [], tools: [], toolConcurrency: 0 } };',
        );
        const badScanner = new AgentScannerService();
        assert.throws(() => badScanner.onModuleInit(), /Invalid default AgentDefinition export/);
      } finally {
        process.chdir(prevCwd);
        await rm(fixture, { recursive: true, force: true });
      }
    });
  });

  describe('2. 同轮多 tool_calls 受控并发、顺序回写、审批屏障与并发子 Agent', () => {
    it('按 toolConcurrency=2 并发执行 4 个工具，乱序完成仍按原始 toolCalls 顺序回写步骤与消息', async () => {
      let active = 0;
      let peakActive = 0;
      const completionOrder = [];
      const delays = { c1: 60, c2: 20, c3: 50, c4: 10 };

      const calls = [
        { id: 'c1', name: 'work', args: { id: 'c1' } },
        { id: 'c2', name: 'work', args: { id: 'c2' } },
        { id: 'c3', name: 'work', args: { id: 'c3' } },
        { id: 'c4', name: 'work', args: { id: 'c4' } },
      ];

      const tools = {
        get: name => (name === 'work' ? {
          name: 'work',
          inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
          async execute(input) {
            active++;
            peakActive = Math.max(peakActive, active);
            await delay(delays[input.id]);
            active--;
            completionOrder.push(input.id);
            return { done: input.id };
          },
        } : undefined),
      };

      const observedToolMessages = [];
      const recordedSteps = [];
      const planner = {
        async plan(messages) {
          if (messages.length === 0) {
            return {
              toolCalls: calls,
              response: {
                role: 'assistant',
                content: null,
                tool_calls: calls.map(c => ({
                  id: c.id,
                  type: 'function',
                  function: { name: c.name, arguments: JSON.stringify(c.args) },
                })),
              },
            };
          }
          observedToolMessages.push(...messages.filter(m => m.role === 'tool'));
          return { finalAnswer: 'parallel-ok' };
        },
      };

      const graph = createAgentGraph({
        planner,
        executor: new ExecutorService({ get: () => undefined }, tools),
        allowed: { skills: [], tools: ['work'] },
        toolConcurrency: 2,
        recordStep: step => { recordedSteps.push(step); },
      });

      const state = await graph.invoke({ messages: [], tools: [], steps: [], iteration: 0, maxIterations: 3 });
      assert.equal(state.finalAnswer, 'parallel-ok');
      assert.equal(peakActive, 2, '峰值并发必须严格受限于 toolConcurrency=2 且大于 1');
      assert.notDeepEqual(completionOrder, ['c1', 'c2', 'c3', 'c4'], '任务应乱序完成以证明真实并发');

      // plan 步骤应包含 calls 摘要
      const planStep = recordedSteps.find(s => s.type === 'plan' && s.output && s.output.type === 'invoke');
      assert.equal(planStep.output.calls.length, 4);

      // tool 步骤与 tool 消息必须严格按原始调用顺序 [c1, c2, c3, c4] 排列
      const execIds = recordedSteps.filter(s => s.type === 'tool').map(s => s.toolCallId);
      assert.deepEqual(execIds, ['c1', 'c2', 'c3', 'c4']);
      assert.deepEqual(observedToolMessages.map(m => m.tool_call_id), ['c1', 'c2', 'c3', 'c4']);
    });

    it('toolConcurrency=1 时强制退化为严格串行执行', async () => {
      let active = 0;
      let peakActive = 0;
      const calls = [
        { id: 's1', name: 'work', args: { id: 's1' } },
        { id: 's2', name: 'work', args: { id: 's2' } },
        { id: 's3', name: 'work', args: { id: 's3' } },
      ];
      const tools = {
        get: () => ({
          name: 'work',
          inputSchema: { type: 'object' },
          async execute(input) {
            active++;
            peakActive = Math.max(peakActive, active);
            await delay(15);
            active--;
            return input.id;
          },
        }),
      };
      const planner = {
        async plan(messages) {
          if (messages.length === 0) return { toolCalls: calls, response: { role: 'assistant', content: null } };
          return { finalAnswer: 'serial-ok' };
        },
      };
      const graph = createAgentGraph({
        planner,
        executor: new ExecutorService({ get: () => undefined }, tools),
        allowed: { skills: [], tools: ['work'] },
        toolConcurrency: 1,
      });

      const state = await graph.invoke({ messages: [], tools: [], steps: [], iteration: 0, maxIterations: 3 });
      assert.equal(state.finalAnswer, 'serial-ok');
      assert.equal(peakActive, 1);
    });

    it('审批屏障：[safe1, safe2, danger, safe3] 并行执行前置安全批次，挂起前绝不提前触发 safe3', async () => {
      let safePeak = 0;
      let safeActive = 0;
      const executed = [];

      const skillsMap = {
        safe: {
          name: 'safe',
          description: 'safe',
          inputSchema: { type: 'object' },
          async execute(input) {
            safeActive++;
            safePeak = Math.max(safePeak, safeActive);
            await delay(25);
            safeActive--;
            executed.push(input.tag);
            return { tag: input.tag };
          },
        },
        danger: {
          name: 'danger',
          approval: 'required',
          description: 'danger',
          inputSchema: { type: 'object' },
          async execute(input) {
            executed.push(input.tag);
            return { approved: input.tag };
          },
        },
      };

      const runs = new Map();
      const trace = new TraceService({
        save: async run => { runs.set(run.runId, structuredClone(run)); },
        load: async id => (runs.has(id) ? structuredClone(runs.get(id)) : null),
      });
      const config = makeMockConfig({
        'agentConfig.threadEnabled': false,
        'ai.runtime.toolConcurrency': 4,
      });
      const skills = { get: name => skillsMap[name] };
      const tools = { get: () => undefined };
      const agents = { get: name => (name === 'mixed' ? { name: 'mixed', skills: ['safe', 'danger'], tools: [] } : undefined) };
      const planner = {
        async plan(messages) {
          if (messages.some(m => m.role === 'tool')) {
            return { finalAnswer: 'mixed-done' };
          }
          return {
            toolCalls: [
              { id: 'k1', name: 'safe', args: { tag: 'safe1' } },
              { id: 'k2', name: 'safe', args: { tag: 'safe2' } },
              { id: 'k3', name: 'danger', args: { tag: 'danger1' } },
              { id: 'k4', name: 'safe', args: { tag: 'safe3' } },
            ],
            response: { role: 'assistant', content: null },
          };
        },
      };

      const orchestrator = new LangGraphOrchestratorService(
        agents, skills, tools, planner, new ExecutorService(skills, tools, config),
        trace, new ThreadService(config), { load: async () => null, save: async () => undefined },
        { check: () => ({ safe: true }) }, config,
      );

      const paused = await orchestrator.run('mixed', 'go', undefined, undefined, { scope: 's1' });
      assert.equal(paused.status, 'waiting_approval');
      assert.equal(paused.approval.name, 'danger');
      assert.equal(safePeak, 2, '前置 safe1 与 safe2 应并发执行');
      assert.ok(!executed.includes('safe3'), '审批点之后的 safe3 在挂起前绝不可被提前执行');
      assert.ok(!executed.includes('danger1'));

      await orchestrator.decide(paused.runId, paused.approval.id, true, { scope: 's1', approve: true });
      let done = null;
      for (let i = 0; i < 60; i++) {
        const latest = await orchestrator.find(paused.runId, { scope: 's1' });
        if (latest.status === 'succeeded') {
          done = latest;
          break;
        }
        await delay(10);
      }
      assert.ok(done, '批准后应完成后续所有调用');
      assert.equal(done.output, 'mixed-done');
      assert.ok(executed.includes('danger1'));
      assert.ok(executed.includes('safe3'));
      const skillSteps = done.steps.filter(s => s.type === 'skill').map(s => s.toolCallId);
      assert.deepEqual(skillSteps, ['k1', 'k2', 'k3', 'k4']);
    });

    it('并发子 Agent 委派共享预算不超发且按序回写', async () => {
      let childActive = 0;
      let childPeak = 0;
      const runs = new Map();
      const trace = new TraceService({
        save: async run => { runs.set(run.runId, structuredClone(run)); },
        load: async id => (runs.has(id) ? structuredClone(runs.get(id)) : null),
      });
      const config = makeMockConfig({
        'agentConfig.threadEnabled': false,
        'ai.runtime.toolConcurrency': 3,
        'ai.runtime.delegation.maxChildRuns': 2,
        'ai.runtime.delegation.maxModelCalls': 10,
      });
      const agents = {
        get: name => ({
          root: { name: 'root', skills: [], tools: [], delegates: ['worker'] },
          worker: { name: 'worker', skills: [], tools: [] },
        }[name]),
      };
      const skills = { get: () => undefined };
      const tools = { get: () => undefined };
      const planner = {
        async plan(messages) {
          const last = messages[messages.length - 1];
          if (last.role === 'tool') {
            return { finalAnswer: 'delegates-done' };
          }
          if (last.content === 'dispatch') {
            return {
              toolCalls: [
                { id: 'd1', name: 'agent-delegate', args: { agent: 'worker', input: 'job-1' } },
                { id: 'd2', name: 'agent-delegate', args: { agent: 'worker', input: 'job-2' } },
                { id: 'd3', name: 'agent-delegate', args: { agent: 'worker', input: 'job-3' } },
              ],
              response: { role: 'assistant', content: null },
            };
          }
          childActive++;
          childPeak = Math.max(childPeak, childActive);
          await delay(30);
          childActive--;
          return { finalAnswer: `done:${last.content}` };
        },
      };

      const orchestrator = new LangGraphOrchestratorService(
        agents, skills, tools, planner, new ExecutorService(skills, tools, config),
        trace, new ThreadService(config), { load: async () => null, save: async () => undefined },
        { check: () => ({ safe: true }) }, config,
      );

      const res = await orchestrator.run('root', 'dispatch');
      assert.equal(res.output, 'delegates-done');
      assert.equal(childPeak, 2, '2 个子 Agent 应并发执行');
      const delegateSteps = res.steps.filter(s => s.type === 'tool' && s.name === 'agent-delegate');
      assert.deepEqual(delegateSteps.map(s => s.toolCallId), ['d1', 'd2', 'd3']);
      assert.equal(delegateSteps[0].output.output, 'done:job-1');
      assert.equal(delegateSteps[1].output.output, 'done:job-2');
      assert.equal(delegateSteps[2].error.code, 'DELEGATE_BUDGET_EXCEEDED');
    });

    it('AbortSignal 取消时立即中止在途并行工具并阻止启动后续调用', async () => {
      const controller = new AbortController();
      let abortedObserved = false;
      let started = 0;

      const tools = {
        get: () => ({
          name: 'slow',
          inputSchema: { type: 'object' },
          async execute(_input, ctx) {
            started++;
            if (ctx && ctx.signal) {
              ctx.signal.addEventListener('abort', () => { abortedObserved = true; }, { once: true });
            }
            await delay(500, undefined, { signal: ctx && ctx.signal });
            return 'late';
          },
        }),
      };

      const graph = createAgentGraph({
        planner: {
          async plan() {
            return {
              toolCalls: [
                { id: 'a1', name: 'slow', args: {} },
                { id: 'a2', name: 'slow', args: {} },
                { id: 'a3', name: 'slow', args: {} },
              ],
              response: { role: 'assistant', content: null },
            };
          },
        },
        executor: new ExecutorService({ get: () => undefined }, tools),
        allowed: { skills: [], tools: ['slow'] },
        toolConcurrency: 2,
        signal: controller.signal,
      });

      setTimeout(() => controller.abort(), 30);
      await assert.rejects(
        graph.invoke({ messages: [], tools: [], steps: [], iteration: 0, maxIterations: 2 }),
        err => err && err.name === 'AbortError',
      );
      assert.equal(abortedObserved, true);
      assert.equal(started, 2, '第 3 个调用不应被启动');
    });
  });

  describe('3. 工具级超时（TOOL_TIMEOUT）与超大输出截断（truncated）', () => {
    it('超时返回 TOOL_TIMEOUT 观察错误并触发子 AbortSignal，能力级 timeoutMs 优先于全局配置', async () => {
      let receivedAbort = false;
      const slowTool = {
        name: 'slow-tool',
        timeoutMs: 40,
        inputSchema: { type: 'object' },
        async execute(_input, ctx) {
          if (ctx && ctx.signal) {
            ctx.signal.addEventListener('abort', () => { receivedAbort = true; }, { once: true });
          }
          await delay(300);
          return 'never';
        },
      };
      const config = makeMockConfig({ 'ai.tools': { timeoutMs: 5000 } });
      const executor = new ExecutorService(
        { get: () => undefined },
        { get: name => (name === 'slow-tool' ? slowTool : undefined) },
        config,
      );

      const res = await executor.execute('slow-tool', {}, {});
      assert.equal(res.type, 'observe');
      assert.equal(res.error.code, 'TOOL_TIMEOUT');
      assert.match(res.error.message, /timed out after 40ms/);
      assert.equal(receivedAbort, true);
    });

    it('invokeSkill 直调超时时抛出 CapabilityTimeoutError', async () => {
      const executor = new ExecutorService({ get: () => undefined }, { get: () => undefined });
      const skill = {
        name: 'hang-skill',
        timeoutMs: 30,
        description: 'hang',
        inputSchema: { type: 'object' },
        async execute() {
          await delay(200);
          return 'ok';
        },
      };
      await assert.rejects(
        executor.invokeSkill(skill, {}),
        err => err instanceof CapabilityTimeoutError && err.code === 'TOOL_TIMEOUT',
      );
    });

    it('超大字符串、对象与循环引用输出自动截断并标注 truncated: true', async () => {
      const longStr = 'A'.repeat(200);
      const strRes = truncateToolOutput(longStr, 50);
      assert.equal(strRes.truncated, true);
      assert.ok(strRes.output.startsWith('A'.repeat(50)));
      assert.match(strRes.output, /truncated: 200 chars total, limit 50/);

      const bigObj = { items: Array.from({ length: 50 }, (_, i) => `item-${i}`) };
      const objRes = truncateToolOutput(bigObj, 80);
      assert.equal(objRes.truncated, true);
      assert.equal(objRes.output.truncated, true);
      assert.equal(objRes.output.maxOutputChars, 80);
      assert.equal(objRes.output.preview.length, 80);
      assert.ok(objRes.output.originalChars > 80);

      const circular = { label: 'x'.repeat(100) };
      circular.self = circular;
      const circRes = truncateToolOutput(circular, 40);
      assert.equal(circRes.truncated, true);
      assert.equal(circRes.output.preview.length, 40);

      // 通过 ExecutorService 执行并验证 ExecutionResult.truncated
      const config = makeMockConfig({ 'ai.tools': { maxOutputChars: 60 } });
      const executor = new ExecutorService(
        { get: () => undefined },
        {
          get: () => ({
            name: 'verbose',
            inputSchema: { type: 'object' },
            async execute() { return { data: 'Z'.repeat(200) }; },
          }),
        },
        config,
      );
      const execRes = await executor.execute('verbose', {}, {});
      assert.equal(execRes.type, 'tool');
      assert.equal(execRes.truncated, true);
      assert.equal(execRes.output.truncated, true);
    });
  });

  describe('4. 内置 http-request 工具（白名单、SSRF 防护、重定向复检与流式截断）', () => {
    it('isHostAllowed 与 isPrivateIpAddress 安全边界判断准确', () => {
      assert.equal(isHostAllowed('api.example.com', ['api.example.com']), true);
      assert.equal(isHostAllowed('sub.api.example.com', ['*.example.com']), true);
      assert.equal(isHostAllowed('example.com', ['*.example.com']), false);
      assert.equal(isHostAllowed('evil-example.com', ['*.example.com']), false);

      assert.equal(isPrivateIpAddress('127.0.0.1'), true);
      assert.equal(isPrivateIpAddress('10.1.2.3'), true);
      assert.equal(isPrivateIpAddress('172.16.0.1'), true);
      assert.equal(isPrivateIpAddress('192.168.1.10'), true);
      assert.equal(isPrivateIpAddress('169.254.169.254'), true);
      assert.equal(isPrivateIpAddress('::1'), true);
      assert.equal(isPrivateIpAddress('fc00::1'), true);
      assert.equal(isPrivateIpAddress('fe80::1'), true);
      assert.equal(isPrivateIpAddress('::ffff:127.0.0.1'), true);
      assert.equal(isPrivateIpAddress('93.184.216.34'), false);
      assert.equal(isPrivateIpAddress('2606:2800:220:1:248:1893:25c8:1946'), false);
    });

    it('未配置 allowedHosts 时默认拒绝，并拦截私网/非白名单方法/非法重定向/大响应体', async () => {
      const baseUrl = 'http://127.0.0.1:18080';
      const origFetch = globalThis.fetch;

      globalThis.fetch = async (url, init = {}) => {
        const parsed = new URL(url);
        const reqHeaders = Object.fromEntries(
          Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]),
        );

        if (parsed.pathname === '/json') {
          return new Response(
            JSON.stringify({
              query: Object.fromEntries(parsed.searchParams),
              clientHeader: reqHeaders['x-client'],
              customHeader: reqHeaders['x-custom'],
            }),
            {
              status: 200,
              headers: {
                'content-type': 'application/json',
                'set-cookie': 'secret=abc; HttpOnly',
                'x-trace': 'ok',
              },
            },
          );
        }
        if (parsed.pathname === '/redirect-ok') {
          return new Response(null, {
            status: 302,
            headers: { location: '/json?via=redirect' },
          });
        }
        if (parsed.pathname === '/redirect-evil') {
          return new Response(null, {
            status: 302,
            headers: { location: 'http://evil.invalid/steal' },
          });
        }
        if (parsed.pathname === '/large') {
          return new Response('X'.repeat(500), {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          });
        }
        return new Response('not found', { status: 404 });
      };

      try {
        // 1) 未配置白名单默认拒绝
        const disabledTool = createHttpRequestTool({
          moduleRef: { get: () => makeMockConfig({}) },
        });
        await assert.rejects(
          disabledTool.execute({ url: `${baseUrl}/json` }),
          /HTTP tool is disabled/,
        );

        // 2) 白名单包含 127.0.0.1 但 allowPrivateNetworks=false 时拦截 SSRF
        const ssrfBlockedTool = createHttpRequestTool({
          moduleRef: {
            get: () => makeMockConfig({
              'ai.tools': { http: { allowedHosts: ['127.0.0.1'] } },
            }),
          },
        });
        await assert.rejects(
          ssrfBlockedTool.execute({ url: `${baseUrl}/json` }),
          /private IP "127\.0\.0\.1" is blocked/,
        );

        // 3) 显式允许私网测试请求、defaultHeaders 覆盖防伪造、剥离 set-cookie、重定向校验与字节截断
        const allowedTool = createHttpRequestTool({
          moduleRef: {
            get: () => makeMockConfig({
              'ai.tools': {
                http: {
                  allowedHosts: ['127.0.0.1'],
                  allowedMethods: ['GET'],
                  allowPrivateNetworks: true,
                  maxResponseBytes: 128,
                  allowedHeaders: ['x-custom', 'x-client'],
                  defaultHeaders: { 'x-client': 'server-enforced' },
                },
              },
            }),
          },
        });

        const okRes = await allowedTool.execute({
          url: `${baseUrl}/json`,
          query: { page: 2 },
          headers: { 'x-custom': 'yes', 'x-client': 'spoofed' },
        });
        assert.equal(okRes.status, 200);
        assert.equal(okRes.body.query.page, '2');
        assert.equal(okRes.body.clientHeader, 'server-enforced');
        assert.equal(okRes.body.customHeader, 'yes');
        assert.equal(okRes.headers['set-cookie'], undefined);
        assert.equal(okRes.headers['x-trace'], 'ok');

        // 禁止非白名单方法与禁止请求头
        await assert.rejects(
          allowedTool.execute({ url: `${baseUrl}/json`, method: 'DELETE' }),
          /HTTP method "DELETE" is not allowed/,
        );
        await assert.rejects(
          allowedTool.execute({ url: `${baseUrl}/json`, headers: { host: 'evil.com' } }),
          /Header "host" is forbidden/,
        );

        // 重定向到白名单内成功，重定向到非白名单目标拦截
        const redirOk = await allowedTool.execute({ url: `${baseUrl}/redirect-ok` });
        assert.equal(redirOk.status, 200);
        assert.equal(redirOk.body.query.via, 'redirect');
        await assert.rejects(
          allowedTool.execute({ url: `${baseUrl}/redirect-evil` }),
          /Host "evil\.invalid" is not in ai\.tools\.http\.allowedHosts/,
        );

        // 超大响应体按 maxResponseBytes 流式截断
        const largeRes = await allowedTool.execute({ url: `${baseUrl}/large` });
        assert.equal(largeRes.truncated, true);
        assert.equal(largeRes.body.length, 128);
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  describe('5. 内置 sql-query 工具（只读校验、防注入、CTE 感知表 ACL 与行数截断）', () => {
    it('validateReadOnlySql 精准放行合法只读语句并拦截写/DDL/多语句/注释/锁/越权表', () => {
      assert.equal(validateReadOnlySql('SELECT id, name FROM orders WHERE status = ?;').valid, true);
      assert.equal(
        validateReadOnlySql("SELECT 'DROP TABLE users' AS note FROM orders").valid,
        true,
        '字符串字面量内的关键词不应误判',
      );
      assert.equal(
        validateReadOnlySql(
          'WITH active_orders AS (SELECT * FROM orders) SELECT * FROM active_orders JOIN order_items ON active_orders.id = order_items.order_id',
          { allowedTables: ['orders', 'order_items'] },
        ).valid,
        true,
        'CTE 别名不应被误判为未授权物理表',
      );

      // 拦截各种注入与危险语法
      assert.equal(validateReadOnlySql('DELETE FROM orders').valid, false);
      assert.equal(validateReadOnlySql('UPDATE orders SET status = 1').valid, false);
      assert.equal(validateReadOnlySql('INSERT INTO orders VALUES (1)').valid, false);
      assert.equal(validateReadOnlySql('SELECT 1; DROP TABLE orders').valid, false);
      assert.equal(validateReadOnlySql('SELECT * FROM orders -- bypass').valid, false);
      assert.equal(validateReadOnlySql('SELECT /* comment */ * FROM orders').valid, false);
      assert.equal(validateReadOnlySql('SELECT * FROM orders FOR UPDATE').valid, false);
      assert.equal(validateReadOnlySql('SELECT SLEEP(5)').valid, false);
      assert.equal(validateReadOnlySql('SELECT * FROM orders INTO OUTFILE "/tmp/x"').valid, false);

      // 表级白名单与黑名单
      const notAllowed = validateReadOnlySql('SELECT * FROM secrets', { allowedTables: ['orders'] });
      assert.equal(notAllowed.valid, false);
      assert.match(notAllowed.reason, /not in ai\.tools\.sql\.allowedTables/);

      const denied = validateReadOnlySql('SELECT * FROM prod.users_secrets', { deniedTables: ['users_secrets'] });
      assert.equal(denied.valid, false);
      assert.match(denied.reason, /Access to table "prod\.users_secrets" is denied/);
    });

    it('sql-query 默认关闭，开启后支持参数化查询、knex mysql2 结果解包与 maxRows 截断', async () => {
      const disabledTool = createSqlQueryTool({
        moduleRef: { get: () => makeMockConfig({}) },
      });
      await assert.rejects(
        disabledTool.execute({ sql: 'SELECT 1' }),
        /SQL tool is disabled/,
      );

      const captured = [];
      const mockKnex = {
        async raw(sql, params) {
          captured.push({ sql, params });
          // 模拟 mysql2 返回 [rows, fields]
          return [
            [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
            [],
          ];
        },
      };
      const enabledTool = createSqlQueryTool({
        moduleRef: {
          get(token) {
            if (token === ConfigService) {
              return makeMockConfig({
                'ai.tools': {
                  sql: { enabled: true, allowedTables: ['orders'], maxRows: 3 },
                },
              });
            }
            if (token === DatabaseProvider) {
              return { knex: mockKnex };
            }
            return undefined;
          },
        },
      });

      const res = await enabledTool.execute({
        sql: 'SELECT id FROM orders WHERE tenant = ?;',
        params: ['acme'],
        maxRows: 10, // 客户端请求超过服务端上限时强制钳制到 3
      });
      assert.equal(captured.length, 1);
      assert.equal(captured[0].sql, 'SELECT id FROM orders WHERE tenant = ?');
      assert.deepEqual(captured[0].params, ['acme']);
      assert.equal(res.rowCount, 3);
      assert.equal(res.truncated, true);
      assert.deepEqual(res.rows, [{ id: 1 }, { id: 2 }, { id: 3 }]);
    });
  });

  describe('6. 内置 calculator 工具（零 eval 数学表达式求值与防注入）', () => {
    it('精确求值四则运算、右结合幂、函数与变量，并拒绝非法表达式或代码注入', async () => {
      assert.equal(evaluateMathExpression('2 + 3 * 4'), 14);
      assert.equal(evaluateMathExpression('2 ^ 3 ^ 2'), 512);
      assert.equal(evaluateMathExpression('-5 + round(12.3456, 2)'), 7.35);
      assert.equal(evaluateMathExpression('clamp(price * qty * (1 - discount), 0, 500)', {
        price: 100,
        qty: 6,
        discount: 0.1,
      }), 500);
      assert.equal(evaluateMathExpression('min(10, max(2, sqrt(49)))'), 7);

      assert.throws(() => evaluateMathExpression('1 / 0'), /Division by zero/);
      assert.throws(() => evaluateMathExpression('process.exit(1)'), /Unexpected character/);
      assert.throws(() => evaluateMathExpression('constructor(1)'), /Unknown function/);
      assert.throws(() => evaluateMathExpression('10 ^ 1000'), /non-finite/);

      const tool = createCalculatorTool({});
      const out = await tool.execute({ expression: 'round(PI, 4)' });
      assert.deepEqual(out, { expression: 'round(PI, 4)', result: 3.1416 });
    });
  });

  describe('7. NestJS HTTP 端到端集成（内置工具注册、脱敏配置、并发执行与直调超时 408）', () => {
    it('完整注册 5 个内置工具、并行调用 calculator+sql-query、GET /agent/config 脱敏与直调 408', async () => {
      const fixture = await mkdtemp(join(tmpdir(), 'e06-e2e-'));
      const secret = 'e06-test-secret';
      const app = await NestFactory.create(AppModule.register({
        ai: {
          runtime: { toolConcurrency: 3 },
          store: {
            trace: join(fixture, 'trace'),
            memory: { path: join(fixture, 'memory') },
            vector: { path: join(fixture, 'vector.json') },
          },
          access: {
            keys: {
              ci: { secret, scope: 'e06', agents: ['analyst'], skills: ['slow-direct'] },
            },
          },
          tools: {
            timeoutMs: 5000,
            maxOutputChars: 8000,
            http: {
              allowedHosts: ['api.example.com'],
              defaultHeaders: { authorization: 'Bearer super-secret-token-do-not-leak' },
            },
            sql: {
              enabled: true,
              allowedTables: ['orders'],
              maxRows: 50,
              executor: async () => [{ total: 250 }, { total: 150 }],
            },
          },
          llm: {
            default: 'mock',
            models: {
              mock: {
                use: {
                  async chat(messages) {
                    const toolMsgs = messages.filter(m => m.role === 'tool');
                    if (toolMsgs.length > 0) {
                      const sqlOut = JSON.parse(toolMsgs[0].content).output;
                      const calcOut = JSON.parse(toolMsgs[1].content).output;
                      return {
                        output: `rows=${sqlOut.rowCount},avg=${calcOut.result}`,
                      };
                    }
                    return {
                      output: '',
                      message: {
                        role: 'assistant',
                        content: null,
                        tool_calls: [
                          {
                            id: 't-sql',
                            type: 'function',
                            function: {
                              name: 'sql-query',
                              arguments: JSON.stringify({ sql: 'SELECT total FROM orders' }),
                            },
                          },
                          {
                            id: 't-calc',
                            type: 'function',
                            function: {
                              name: 'calculator',
                              arguments: JSON.stringify({ expression: '(250 + 150) / 2' }),
                            },
                          },
                        ],
                      },
                    };
                  },
                },
              },
            },
          },
        },
      }), { logger: false, rawBody: true });

      try {
        await app.init();

        // 1) 验证 5 个内置工具均已自动注册
        const names = app.get(ToolRegistryService).listNames();
        for (const expected of ['retrieve', 'service-invoke', 'http-request', 'sql-query', 'calculator']) {
          assert.ok(names.includes(expected), `内置工具 ${expected} 应已注册`);
        }

        // 2) 注册业务 Agent 与慢 Skill
        app.get(AgentScannerService).get = name => (name === 'analyst'
          ? { name: 'analyst', skills: [], tools: ['sql-query', 'calculator'] }
          : undefined);
        app.get(SkillScannerService).get = name => (name === 'slow-direct'
          ? {
            name: 'slow-direct',
            timeoutMs: 35,
            description: 'slow',
            inputSchema: { type: 'object' },
            async execute() {
              await delay(200);
              return { ok: true };
            },
          }
          : undefined);

        // 3) POST /api/ai/agent/run 同轮并行调用 sql-query + calculator
        const runBody = JSON.stringify({ agent: 'analyst', input: '统计订单均值' });
        const runRes = await dispatch(
          app,
          'POST',
          '/api/ai/agent/run',
          createSignedHeaders('ci', secret, 'POST', '/api/ai/agent/run', runBody),
          runBody,
        );
        assert.equal(runRes.status, 201);
        const runPayload = JSON.parse(runRes.body).data;
        assert.equal(runPayload.output, 'rows=2,avg=200');
        assert.deepEqual(
          runPayload.steps.filter(s => s.type === 'tool').map(s => s.name),
          ['sql-query', 'calculator'],
        );

        // 4) POST /api/ai/skill/slow-direct/invoke 超时返回 408
        const invokeBody = JSON.stringify({});
        const invokeRes = await dispatch(
          app,
          'POST',
          '/api/ai/skill/slow-direct/invoke',
          createSignedHeaders('ci', secret, 'POST', '/api/ai/skill/slow-direct/invoke', invokeBody),
          invokeBody,
        );
        assert.equal(invokeRes.status, 408);

        // 5) GET /api/ai/agent/config 返回脱敏的 toolConcurrency 与 tools 摘要，绝不泄漏 defaultHeaders 密钥
        const time = String(Date.now());
        const legacySign = createHash('md5').update(`klx05hb3n1c9ujp8uhxbs2ikkiowp212_${time}`).digest('hex');
        const cfgRes = await dispatch(app, 'GET', '/api/ai/agent/config', { s_t: time, s_sign: legacySign }, '');
        assert.equal(cfgRes.status, 200);
        assert.doesNotMatch(cfgRes.body, /super-secret-token-do-not-leak/);
        const cfg = JSON.parse(cfgRes.body);
        assert.equal(cfg.toolConcurrency, 3);
        assert.equal(cfg.tools.timeoutMs, 5000);
        assert.equal(cfg.tools.maxOutputChars, 8000);
        assert.deepEqual(cfg.tools.http.allowedHosts, ['api.example.com']);
        assert.equal(cfg.tools.sql.enabled, true);
        assert.deepEqual(cfg.tools.sql.allowedTables, ['orders']);
      } finally {
        await app.close();
        await rm(fixture, { recursive: true, force: true });
      }
    });
  });
});
