const assert = require('node:assert/strict');
const { createHash, createHmac, randomUUID } = require('node:crypto');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { IncomingMessage, ServerResponse } = require('node:http');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Duplex } = require('node:stream');
const { AIMessageChunk } = require('@langchain/core/messages');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../../dist/app.module');
const { AgentScannerService } = require('../../dist/ai/agent/agent-scanner.service');
const { CheckpointService } = require('../../dist/ai/memory/checkpoint.service');
const { ThreadService } = require('../../dist/ai/memory/thread.service');
const {
  compileOutputSchema,
  extractJsonValue,
  isValidOutputSchema,
  validateStructuredOutput,
} = require('../../dist/ai/runtime/internal/structured-output');
const { LangChainPlannerService } = require('../../dist/ai/runtime/langchain/langchain-planner.service');
const { LangGraphOrchestratorService } = require('../../dist/ai/runtime/langgraph/langgraph-orchestrator.service');
const { ExecutorService } = require('../../dist/ai/tool/executor.service');
const { TraceService } = require('../../dist/ai/trace/trace.service');
const { RequestValidationPipe } = require('../../dist/common/validation/request-validation.pipe');

const TICKET_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: ['billing', 'technical', 'other'] },
    priority: { type: 'integer', minimum: 1, maximum: 5 },
    summary: { type: 'string', minLength: 1 },
  },
  required: ['category', 'priority', 'summary'],
  additionalProperties: false,
};

function makeConfig(llm, maxIterations = 8) {
  return {
    get(key) {
      if (key === 'ai') return { llm, runtime: { maxIterations } };
      if (key === 'ai.llm') return llm;
      if (key === 'ai.runtime.maxIterations') return maxIterations;
      return undefined;
    },
  };
}

function makeOrchestrator(agentDef, planner, config = makeConfig(undefined)) {
  const records = new Map();
  const trace = new TraceService({
    save: async run => records.set(run.runId, structuredClone(run)),
    load: async id => records.get(id) ?? null,
  });
  const orchestrator = new LangGraphOrchestratorService(
    { get: name => (name === agentDef.name ? agentDef : undefined) },
    { get: () => undefined },
    { get: () => undefined },
    planner,
    new ExecutorService({ get: () => undefined }, { get: () => undefined }),
    trace,
    new ThreadService({ get: () => false }),
    new CheckpointService({ save: async () => {}, load: async () => null }),
    { check: () => ({ safe: true }) },
    config,
  );
  return { orchestrator, records, trace };
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
    });
    req.complete = true;

    const res = new ServerResponse(req);
    const timeout = setTimeout(() => reject(new Error(`No response for ${method} ${url}`)), 1500);
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

describe('E05 · Agent 结构化输出（outputSchema 与自动纠错重试）', () => {
  describe('1. JSON 提取、ajv 严格校验与 AgentScanner 启动校验', () => {
    it('支持直接 JSON、Markdown 代码块与字符串感知括号提取，严格执行 ajv Schema 校验', () => {
      assert.deepEqual(extractJsonValue('{"a":1}'), { ok: true, value: { a: 1 } });
      assert.deepEqual(extractJsonValue('```json\n[1, 2, 3]\n```'), { ok: true, value: [1, 2, 3] });
      assert.deepEqual(
        extractJsonValue('结果如下：{"note":"包含花括号 {ok}","count":2} 请查收'),
        { ok: true, value: { note: '包含花括号 {ok}', count: 2 } },
      );
      assert.equal(extractJsonValue('plain text without json').ok, false);
      assert.equal(extractJsonValue('').ok, false);

      // 校验合法 JSON（带 Markdown 围栏时自动剥离并规范序列化）
      const ok = validateStructuredOutput(
        TICKET_SCHEMA,
        '```json\n{"category": "technical", "priority": 2, "summary": "API timeout"}\n```',
      );
      assert.equal(ok.valid, true);
      assert.deepEqual(ok.value, { category: 'technical', priority: 2, summary: 'API timeout' });
      assert.equal(ok.serialized, '{"category":"technical","priority":2,"summary":"API timeout"}');

      // 不做隐式类型转换（priority 为字符串 "2" 必须拒绝）
      const badType = validateStructuredOutput(
        TICKET_SCHEMA,
        '{"category":"technical","priority":"2","summary":"x"}',
      );
      assert.equal(badType.valid, false);
      assert.match(badType.reason, /priority/);

      // 非法 Schema 拒绝编译
      assert.equal(isValidOutputSchema(TICKET_SCHEMA), true);
      assert.equal(isValidOutputSchema({}), false);
      assert.equal(isValidOutputSchema([]), false);
      assert.equal(isValidOutputSchema({ type: 'invalid-json-schema-type' }), false);
      assert.throws(() => compileOutputSchema({}), /non-empty JSON Schema object/);
    });

    it('AgentScannerService 启动期校验 outputSchema 与 maxOutputRetries', async () => {
      const fixture = await mkdtemp(join(tmpdir(), 'e05-scanner-'));
      const agentsDir = join(fixture, 'dist', 'agents');
      await mkdir(agentsDir, { recursive: true });
      const prevCwd = process.cwd();

      try {
        await writeFile(
          join(agentsDir, 'structured.agent.js'),
          `module.exports = { default: {
            name: 'structured-agent',
            skills: [],
            tools: [],
            outputSchema: ${JSON.stringify(TICKET_SCHEMA)},
            maxOutputRetries: 2,
          } };`,
        );
        process.chdir(fixture);
        const scanner = new AgentScannerService();
        scanner.onModuleInit();
        const loaded = scanner.get('structured-agent');
        assert.ok(loaded);
        assert.deepEqual(loaded.outputSchema, TICKET_SCHEMA);
        assert.equal(loaded.maxOutputRetries, 2);

        // 非法 outputSchema 在启动扫描期立即报错
        await writeFile(
          join(agentsDir, 'bad-schema.agent.js'),
          `module.exports = { default: {
            name: 'bad-schema',
            skills: [],
            tools: [],
            outputSchema: { type: 'unknown-type' },
          } };`,
        );
        assert.throws(() => new AgentScannerService().onModuleInit(), /Invalid default AgentDefinition export/);
      } finally {
        process.chdir(prevCwd);
        await rm(fixture, { recursive: true, force: true });
      }
    });
  });

  describe('2. 自动纠错重试闭环与三种循环模式兼容', () => {
    it('ReAct 模式：系统提示词自动注入 Schema，格式非法时触发有限次纠错并返回 structuredOutput', async () => {
      const seenMessages = [];
      let turn = 0;
      const planner = {
        async plan(messages) {
          seenMessages.push(messages);
          turn++;
          if (turn === 1) {
            return {
              planner: 'langchain',
              model: 'primary',
              finalAnswer: '这不是 JSON 文本',
              usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
            };
          }
          if (turn === 2) {
            // 合法 JSON 但缺少 priority 且 category 枚举非法
            return {
              planner: 'langchain',
              model: 'primary',
              finalAnswer: '{"category":"invalid","summary":"missing priority"}',
              usage: { inputTokens: 12, outputTokens: 6, totalTokens: 18 },
            };
          }
          return {
            planner: 'langchain',
            model: 'primary',
            finalAnswer: '```json\n{"category":"billing","priority":1,"summary":"double charged"}\n```',
            usage: { inputTokens: 15, outputTokens: 8, totalTokens: 23 },
          };
        },
      };

      const agent = {
        name: 'ticket-agent',
        skills: [],
        tools: [],
        prompt: '你是一名工单分类助手。',
        outputSchema: TICKET_SCHEMA,
        maxOutputRetries: 2,
      };
      const { orchestrator, records } = makeOrchestrator(agent, planner);

      const res = await orchestrator.run('ticket-agent', '扣了两次费');

      // 系统提示词包含原 prompt 与 Schema 约束
      assert.equal(seenMessages[0][0].role, 'system');
      assert.match(seenMessages[0][0].content, /工单分类助手/);
      assert.match(seenMessages[0][0].content, /"category"/);

      // 纠错消息包含校验失败细节
      assert.match(seenMessages[1].at(-1).content, /not valid JSON/);
      assert.match(seenMessages[2].at(-1).content, /priority|category/);

      // 返回结构化对象与规范 JSON 文本，汇总 3 次模型调用的 token
      assert.deepEqual(res.structuredOutput, {
        category: 'billing',
        priority: 1,
        summary: 'double charged',
      });
      assert.equal(res.output, '{"category":"billing","priority":1,"summary":"double charged"}');
      assert.deepEqual(res.usage, { inputTokens: 37, outputTokens: 18, totalTokens: 55 });

      // Trace 完整记录 2 次校验失败 observe + 2 次 validate-output 纠错 plan + 持久化 structuredOutput
      const saved = records.get(res.runId);
      assert.deepEqual(saved.structuredOutput, res.structuredOutput);
      const repairObserves = saved.steps.filter(s => s.node === 'validate-output' && s.type === 'observe');
      const repairPlans = saved.steps.filter(s => s.node === 'validate-output' && s.type === 'plan');
      assert.equal(repairObserves.length, 2);
      assert.equal(repairPlans.length, 2);
      assert.ok(repairObserves.every(s => s.error?.code === 'INVALID_STRUCTURED_OUTPUT'));
    });

    it('超过 maxOutputRetries（含设为 0）仍不合法时不返回 structuredOutput，并在 final 步骤记录 INVALID_STRUCTURED_OUTPUT', async () => {
      let calls = 0;
      const planner = {
        async plan() {
          calls++;
          return { planner: 'langchain', finalAnswer: '{"category":"bad"}' };
        },
      };

      // maxOutputRetries = 1：初次 1 次 + 纠错 1 次 = 共 2 次
      const agent = {
        name: 'strict-agent',
        skills: [],
        tools: [],
        outputSchema: TICKET_SCHEMA,
        maxOutputRetries: 1,
      };
      const { orchestrator, records } = makeOrchestrator(agent, planner);
      const res = await orchestrator.run('strict-agent', 'test');

      assert.equal(calls, 2);
      assert.equal(res.structuredOutput, undefined);
      assert.equal(records.get(res.runId).structuredOutput, undefined);
      const finalStep = res.steps.at(-1);
      assert.equal(finalStep.type, 'final');
      assert.equal(finalStep.node, 'validate-output');
      assert.equal(finalStep.error.code, 'INVALID_STRUCTURED_OUTPUT');

      // maxOutputRetries = 0：仅校验不重试（只调用 1 次）
      calls = 0;
      const noRetry = makeOrchestrator({ ...agent, name: 'no-retry', maxOutputRetries: 0 }, planner);
      const res0 = await noRetry.orchestrator.run('no-retry', 'test');
      assert.equal(calls, 1);
      assert.equal(res0.structuredOutput, undefined);
      assert.equal(res0.steps.at(-1).error.code, 'INVALID_STRUCTURED_OUTPUT');
    });

    it('Plan-and-Execute 与 Reflection 模式均支持 outputSchema 校验与自动纠错', async () => {
      // 1) plan-and-execute：synthesize 产出非法 JSON -> validate-output 纠错成功
      let peRepairCalled = false;
      const pePlanner = {
        async plan(messages) {
          const last = messages.at(-1).content;
          if (last.includes('ordered execution plan')) return { planner: 'langchain', finalAnswer: '["analyze issue"]' };
          if (last.includes('Work only on step')) return { planner: 'langchain', finalAnswer: 'found network bug' };
          if (last.includes('synthesizing the completed steps')) return { planner: 'langchain', finalAnswer: 'raw synthesis text' };
          peRepairCalled = true;
          return {
            planner: 'langchain',
            finalAnswer: '{"category":"technical","priority":3,"summary":"network bug"}',
          };
        },
      };
      const pe = makeOrchestrator({
        name: 'pe-structured',
        mode: 'plan-and-execute',
        skills: [],
        tools: [],
        outputSchema: TICKET_SCHEMA,
      }, pePlanner);
      const peRes = await pe.orchestrator.run('pe-structured', 'check bug');
      assert.equal(peRepairCalled, true);
      assert.deepEqual(peRes.structuredOutput, { category: 'technical', priority: 3, summary: 'network bug' });

      // 2) reflection：review 通过后若草稿带围栏或缺字段，仍由 validate-output 修正并输出 structuredOutput
      let refRepairCalled = false;
      const refPlanner = {
        async plan(messages) {
          const last = messages.at(-1).content;
          if (last.includes('Review the latest draft')) {
            return { planner: 'langchain', finalAnswer: '{"approved":true,"feedback":"looks good"}' };
          }
          if (last.includes('JSON Schema 校验')) {
            refRepairCalled = true;
            return {
              planner: 'langchain',
              finalAnswer: '{"category":"other","priority":4,"summary":"general inquiry"}',
            };
          }
          return { planner: 'langchain', finalAnswer: '{"category":"other"}' };
        },
      };
      const ref = makeOrchestrator({
        name: 'ref-structured',
        mode: 'reflection',
        skills: [],
        tools: [],
        outputSchema: TICKET_SCHEMA,
      }, refPlanner);
      const refRes = await ref.orchestrator.run('ref-structured', 'hello');
      assert.equal(refRepairCalled, true);
      assert.deepEqual(refRes.structuredOutput, { category: 'other', priority: 4, summary: 'general inquiry' });
    });
  });

  describe('3. 流式无脏 delta、E04 Fallback 联动与 HTTP 端到端集成', () => {
    it('SSE 流式在校验纠错期间不吐脏 delta，纠错时支持主备 Fallback，并在 done/Trace 返回 structuredOutput', async () => {
      const fixture = await mkdtemp(join(tmpdir(), 'e05-http-'));
      let primaryCalls = 0;
      const app = await NestFactory.create(AppModule.register({
        ai: {
          access: {
            keys: { ops: { secret: 'e05-secret', scope: 'e05-scope' } },
          },
          store: {
            trace: join(fixture, 'trace'),
            memory: { path: join(fixture, 'memory') },
            vector: { path: join(fixture, 'vectors.json') },
          },
          llm: {
            default: 'primary',
            fallbacks: ['backup'],
            circuitBreaker: { enabled: false },
            models: {
              primary: {
                use: {
                  async chat() {
                    primaryCalls++;
                    if (primaryCalls === 1) {
                      return { output: '非法的初始纯文本' };
                    }
                    // 第 2 次（纠错调用）主模型 503，验证与 E04 Fallback 联动
                    const err = new Error('primary overloaded');
                    err.status = 503;
                    throw err;
                  },
                },
              },
              backup: {
                use: {
                  async chat() {
                    return { output: '{"category":"technical","priority":2,"summary":"repaired via backup"}' };
                  },
                },
              },
            },
          },
        },
      }), { logger: false, rawBody: true });
      app.useGlobalPipes(new RequestValidationPipe());

      try {
        await app.init();
        app.get(AgentScannerService).get = name => (name === 'classifier' ? {
          name: 'classifier',
          skills: [],
          tools: [],
          outputSchema: TICKET_SCHEMA,
          maxOutputRetries: 2,
        } : undefined);

        const signed = (method, url, body = '') => {
          const time = String(Date.now());
          const nonce = randomUUID();
          const digest = createHash('sha256').update(body).digest('hex');
          const sig = createHmac('sha256', 'e05-secret')
            .update(['ops', method, url, time, nonce, digest].join('\n'))
            .digest('hex');
          return dispatch(app, method, url, {
            'x-agent-key-id': 'ops',
            'x-agent-nonce': nonce,
            s_t: time,
            s_sign: sig,
            ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
          }, body);
        };

        const body = JSON.stringify({ agent: 'classifier', input: '服务报错 500' });
        const streamRes = await signed('POST', '/api/ai/agent/run/stream', body);
        assert.equal(streamRes.status, 201);

        // 不应把非法的初始纯文本作为 delta 推送给客户端
        assert.doesNotMatch(streamRes.body, /event: delta\ndata: \{"content":"非法的初始纯文本"\}/);
        const doneMatch = streamRes.body.match(/event: done\ndata: (.+)/);
        assert.ok(doneMatch);
        const doneData = JSON.parse(doneMatch[1]).data;
        assert.deepEqual(doneData.structuredOutput, {
          category: 'technical',
          priority: 2,
          summary: 'repaired via backup',
        });
        assert.equal(doneData.output, '{"category":"technical","priority":2,"summary":"repaired via backup"}');

        // 纠错阶段的 Fallback 事件也被完整持久化在 Trace 中
        const traceRes = await signed('GET', `/api/ai/trace/${doneData.runId}`);
        assert.equal(traceRes.status, 200);
        const traceData = JSON.parse(traceRes.body).data;
        assert.deepEqual(traceData.structuredOutput, doneData.structuredOutput);
        const fbStep = traceData.steps.find(s => s.type === 'fallback');
        assert.ok(fbStep);
        assert.equal(fbStep.node, 'validate-output');
        assert.equal(fbStep.name, 'primary->backup');

        // 运行详情接口同样包含 structuredOutput
        const runDetail = await signed('GET', `/api/ai/agent/runs/${doneData.runId}`);
        assert.equal(runDetail.status, 200);
        assert.deepEqual(JSON.parse(runDetail.body).data.structuredOutput, doneData.structuredOutput);

        // 也验证 LangChain ChatOpenAI 流式模式下声明 outputSchema 不会直推未校验 chunk
        const lcPlanner = new LangChainPlannerService(makeConfig({
          default: 'lc',
          models: { lc: { provider: 'openai-compatible', apiKey: 'sk-lc', model: 'lc-1', baseURL: 'http://localhost' } },
        }));
        lcPlanner.bindTools = () => ({
          async invoke() {
            return { content: '```json\n{"category":"other","priority":5,"summary":"ok"}\n```', tool_calls: [] };
          },
          async *stream() {
            yield new AIMessageChunk({ content: 'should-not-stream-raw' });
          },
        });
        const emitted = [];
        const lc = makeOrchestrator({
          name: 'lc-structured',
          skills: [],
          tools: [],
          outputSchema: TICKET_SCHEMA,
        }, lcPlanner);
        const lcRes = await lc.orchestrator.run('lc-structured', 'hi', evt => emitted.push(evt));
        assert.deepEqual(lcRes.structuredOutput, { category: 'other', priority: 5, summary: 'ok' });
        const deltaText = emitted.filter(e => e.type === 'delta').map(e => e.content).join('');
        assert.equal(deltaText, '{"category":"other","priority":5,"summary":"ok"}');
      } finally {
        await app.close();
        await rm(fixture, { recursive: true, force: true });
      }
    });
  });
});
