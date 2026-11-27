const assert = require('node:assert/strict');
const { createHash, createHmac, randomUUID } = require('node:crypto');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { IncomingMessage, ServerResponse } = require('node:http');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Duplex } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');
const { AIMessageChunk } = require('@langchain/core/messages');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../../dist/app.module');
const { AgentScannerService } = require('../../dist/ai/agent/agent-scanner.service');
const { CheckpointService } = require('../../dist/ai/memory/checkpoint.service');
const { ThreadService } = require('../../dist/ai/memory/thread.service');
const {
  classifyLlmError,
  LlmCircuitBreakerService,
  LlmCircuitOpenError,
} = require('../../dist/ai/runtime/internal/llm-circuit-breaker');
const {
  resolveCircuitBreakerConfig,
  resolveLlm,
  resolveLlmCandidates,
  resolveLlmParams,
} = require('../../dist/ai/runtime/internal/load-llm-config');
const { LangChainPlannerService } = require('../../dist/ai/runtime/langchain/langchain-planner.service');
const { LangGraphOrchestratorService } = require('../../dist/ai/runtime/langgraph/langgraph-orchestrator.service');
const { ExecutorService } = require('../../dist/ai/tool/executor.service');
const { TraceService } = require('../../dist/ai/trace/trace.service');
const { RequestValidationPipe } = require('../../dist/common/validation/request-validation.pipe');

function makeConfig(llm) {
  return {
    get(key) {
      if (key === 'ai') return { llm };
      if (key === 'ai.llm') return llm;
      if (key === 'ai.runtime.maxIterations') return 5;
      return undefined;
    },
  };
}

function httpError(status, message = `HTTP ${status}`) {
  const err = new Error(message);
  err.status = status;
  return err;
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

describe('E04 · LLM 参数可配、主备模型 Fallback 与熔断', () => {
  describe('1. 配置解析与三层参数覆盖优先级', () => {
    it('按 Agent/调用覆盖 > 模型配置 > 全局 ai.llm > 默认值合并推理参数，并正确透传至 ChatOpenAI 与自定义 Provider', async () => {
      const llm = {
        default: 'primary',
        temperature: 0.4,
        maxTokens: 1024,
        topP: 0.9,
        timeout: 15000,
        maxRetries: 1,
        models: {
          primary: {
            provider: 'openai-compatible',
            apiKey: 'sk-primary-test',
            baseURL: 'https://primary.example.com/v1/',
            model: 'primary-v1',
            temperature: 0.6,
            timeoutMs: 8000,
          },
          custom: {
            maxTokens: 512,
            use: {
              async chat(_messages, opts) {
                return { output: JSON.stringify(opts) };
              },
            },
          },
        },
      };
      const cfg = makeConfig(llm);

      // 1) 模型级覆盖全局，Agent/调用覆盖模型级
      const resolved = resolveLlm(cfg, 'primary', { maxTokens: 2048 });
      assert.equal(resolved.kind, 'langchain');
      assert.equal(resolved.modelKey, 'primary');
      assert.deepEqual(resolved.params, {
        temperature: 0.6,
        maxTokens: 2048,
        topP: 0.9,
        timeoutMs: 8000,
        maxRetries: 1,
      });
      assert.equal(resolved.model.temperature, 0.6);
      assert.equal(resolved.model.maxTokens, 2048);
      assert.equal(resolved.model.topP, 0.9);
      assert.equal(resolved.model.timeout, 8000);
      assert.equal(resolved.model.caller.maxRetries, 1);

      // 2) 未配置时保持默认 temperature=0；无 fallback maxRetries=2，有 fallback maxRetries=0
      assert.deepEqual(resolveLlmParams(undefined, undefined, {}), { temperature: 0, maxRetries: 2 });
      assert.deepEqual(resolveLlmParams(undefined, undefined, { hasFallbacks: true }), { temperature: 0, maxRetries: 0 });

      // 3) 自定义 Provider 收到解析后的推理参数
      const planner = new LangChainPlannerService(cfg);
      const res = await planner.plan([{ role: 'user', content: 'hi' }], [], {
        model: 'custom',
        temperature: 0.75,
        timeout: 5000,
      });
      const received = JSON.parse(res.finalAnswer);
      assert.equal(received.model, 'custom');
      assert.equal(received.temperature, 0.75);
      assert.equal(received.maxTokens, 512);
      assert.equal(received.topP, 0.9);
      assert.equal(received.timeoutMs, 5000);
    });

    it('校验非法推理参数、候选链去重顺序及未知备模型报错', () => {
      assert.throws(() => resolveLlmParams({ temperature: -0.1 }), /temperature/);
      assert.throws(() => resolveLlmParams({ maxTokens: 0 }), /maxTokens/);
      assert.throws(() => resolveLlmParams({ topP: 1.5 }), /topP/);
      assert.throws(() => resolveLlmParams({ timeoutMs: -10 }), /timeoutMs/);
      assert.throws(() => resolveLlmParams({ maxRetries: -1 }), /maxRetries/);

      const cfg = makeConfig({
        default: 'p',
        fallbacks: ['p', 'g1', 'm1'],
        models: {
          p: { fallbacks: ['m1', 'm2'], use: { chat: async () => ({ output: 'p' }) } },
          m1: { use: { chat: async () => ({ output: 'm1' }) } },
          m2: { use: { chat: async () => ({ output: 'm2' }) } },
          g1: { use: { chat: async () => ({ output: 'g1' }) } },
          a1: { use: { chat: async () => ({ output: 'a1' }) } },
        },
      });
      const chain = resolveLlmCandidates(cfg, 'p', ['a1', 'm1']);
      assert.equal(chain.primary, 'p');
      assert.deepEqual(chain.candidates, ['p', 'a1', 'm1', 'm2', 'g1']);

      assert.throws(
        () => resolveLlmCandidates(cfg, 'p', ['missing']),
        /LLM fallback model "missing" is not configured/,
      );

      // 熔断器默认开关规则：单模型无配置关闭；有 fallback 或显式配置开启；enabled: false 可关闭
      const singleCfg = makeConfig({ default: 'p', models: { p: { use: { chat: async () => ({ output: 'ok' }) } } } });
      assert.equal(resolveCircuitBreakerConfig(singleCfg, false).enabled, false);
      assert.equal(resolveCircuitBreakerConfig(singleCfg, true).enabled, true);
      const disabledCfg = makeConfig({
        default: 'p',
        circuitBreaker: { enabled: false },
        models: { p: { use: { chat: async () => ({ output: 'ok' }) } } },
      });
      assert.equal(resolveCircuitBreakerConfig(disabledCfg, true).enabled, false);
    });
  });

  describe('2. 错误分类与主备自动切换（429 / 5xx / 超时 / 网络 / 取消 / 非瞬态）', () => {
    it('classifyLlmError 准确区分瞬态与非瞬态异常', () => {
      assert.deepEqual(classifyLlmError(httpError(429)), {
        retryable: true, reason: 'rate_limit', code: 'LLM_RATE_LIMITED', statusCode: 429,
      });
      assert.deepEqual(classifyLlmError(httpError(503)), {
        retryable: true, reason: 'server_error', code: 'LLM_SERVER_ERROR', statusCode: 503,
      });
      assert.deepEqual(classifyLlmError(new Error('anything'), true), {
        retryable: true, reason: 'timeout', code: 'LLM_TIMEOUT',
      });
      const netErr = Object.assign(new Error('socket closed'), { code: 'ECONNRESET' });
      assert.deepEqual(classifyLlmError(netErr), {
        retryable: true, reason: 'network_error', code: 'LLM_NETWORK_ERROR',
      });
      // 包裹在 cause 里的 502 也能被识别
      const wrapped = new Error('wrapper', { cause: httpError(502) });
      assert.equal(classifyLlmError(wrapped).reason, 'server_error');
      assert.equal(classifyLlmError(wrapped).statusCode, 502);

      // 400 / 401 / 403 / 普通业务错误不可重试
      assert.equal(classifyLlmError(httpError(400)).retryable, false);
      assert.equal(classifyLlmError(httpError(401)).retryable, false);
      assert.equal(classifyLlmError(httpError(403)).retryable, false);
      assert.equal(classifyLlmError(new Error('invalid JSON schema')).retryable, false);
    });

    it('主模型遇 429 / 503 / 超时（含忽略 signal 的挂起 Provider）/ 网络异常时链式切备', async () => {
      const calls = [];
      const cfg = makeConfig({
        default: 'm1',
        fallbacks: ['m2', 'm3'],
        circuitBreaker: { enabled: false },
        models: {
          m1: {
            timeoutMs: 40,
            use: {
              async chat(messages) {
                calls.push('m1');
                const prompt = messages[0].content;
                if (prompt === 'case-429') throw httpError(429, 'rate limit with sk-secret');
                if (prompt === 'case-503') throw httpError(503, 'bad gateway');
                if (prompt === 'case-timeout') {
                  // 故意忽略 signal 挂起，验证 Promise.race 超时兜底生效
                  return new Promise(() => {});
                }
                if (prompt === 'case-net') throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
                return { output: 'from-m1' };
              },
            },
          },
          m2: {
            use: {
              async chat(messages) {
                calls.push('m2');
                if (messages[0].content === 'case-429') throw httpError(500, 'm2 also down');
                return { output: 'from-m2' };
              },
            },
          },
          m3: {
            use: {
              async chat() {
                calls.push('m3');
                return { output: 'from-m3' };
              },
            },
          },
        },
      });
      const planner = new LangChainPlannerService(cfg);

      // 多跳切备：m1 (429) -> m2 (500) -> m3 (ok)
      const events = [];
      const r1 = await planner.plan([{ role: 'user', content: 'case-429' }], [], {
        onFallback: e => events.push(e),
      });
      assert.equal(r1.finalAnswer, 'from-m3');
      assert.equal(r1.model, 'm3');
      assert.equal(events.length, 2);
      assert.deepEqual(events[0], {
        fromModel: 'm1', toModel: 'm2', reason: 'rate_limit', code: 'LLM_RATE_LIMITED',
        statusCode: 429, circuitState: 'closed', attempt: 1,
      });
      assert.deepEqual(events[1], {
        fromModel: 'm2', toModel: 'm3', reason: 'server_error', code: 'LLM_SERVER_ERROR',
        statusCode: 500, circuitState: 'closed', attempt: 2,
      });

      // 超时切备：m1 (40ms 超时) -> m2 (ok)
      const rTimeout = await planner.plan([{ role: 'user', content: 'case-timeout' }], []);
      assert.equal(rTimeout.finalAnswer, 'from-m2');
      assert.equal(rTimeout.model, 'm2');
      assert.equal(rTimeout.fallbacks[0].reason, 'timeout');

      // 网络故障切备：m1 (ECONNRESET) -> m2 (ok)
      const rNet = await planner.plan([{ role: 'user', content: 'case-net' }], []);
      assert.equal(rNet.finalAnswer, 'from-m2');
      assert.equal(rNet.fallbacks[0].reason, 'network_error');
    });

    it('非瞬态 400 错误与调用方 AbortSignal 取消不触发切备且不计入熔断', async () => {
      let backupCalls = 0;
      const cb = new LlmCircuitBreakerService();
      const cfg = makeConfig({
        default: 'primary',
        fallbacks: ['backup'],
        circuitBreaker: { enabled: true, failureThreshold: 1, cooldownMs: 10000 },
        models: {
          primary: {
            use: {
              async chat(messages, opts) {
                if (messages[0].content === 'bad-req') throw httpError(400, 'invalid prompt');
                await delay(500, undefined, { signal: opts.signal });
                return { output: 'late' };
              },
            },
          },
          backup: {
            use: {
              async chat() {
                backupCalls++;
                return { output: 'backup' };
              },
            },
          },
        },
      });
      const planner = new LangChainPlannerService(cfg, cb);

      await assert.rejects(() => planner.plan([{ role: 'user', content: 'bad-req' }], []), /invalid prompt/);
      assert.equal(backupCalls, 0);
      assert.equal(cb.getState('primary').state, 'closed');
      assert.equal(cb.getState('primary').consecutiveFailures, 0);

      const controller = new AbortController();
      const pending = planner.plan([{ role: 'user', content: 'slow' }], [], { signal: controller.signal });
      setTimeout(() => controller.abort(), 15);
      await assert.rejects(() => pending);
      assert.equal(backupCalls, 0);
      assert.equal(cb.getState('primary').state, 'closed');
    });

    it('流式中途失败时触发 resetDelta 清理临时文本后再输出备模型流', async () => {
      const cfg = makeConfig({
        default: 'p',
        fallbacks: ['b'],
        models: {
          p: { provider: 'openai-compatible', apiKey: 'sk-p', model: 'model-p', baseURL: 'http://localhost' },
          b: { provider: 'openai-compatible', apiKey: 'sk-b', model: 'model-b', baseURL: 'http://localhost' },
        },
      });
      const planner = new LangChainPlannerService(cfg);
      planner.bindTools = (_tools, model) => ({
        async *stream() {
          if (model.model === 'model-p') {
            yield new AIMessageChunk({ content: '部分脏文本' });
            throw httpError(503, 'upstream reset');
          }
          yield new AIMessageChunk({ content: '备模型' });
          yield new AIMessageChunk({ content: '完整答案' });
        },
      });

      const log = [];
      const result = await planner.plan([{ role: 'user', content: 'stream' }], [], {
        onDelta: c => log.push(`delta:${c}`),
        resetDelta: () => log.push('reset'),
        onFallback: e => log.push(`fallback:${e.fromModel}->${e.toModel}:${e.reason}`),
      });

      assert.equal(result.finalAnswer, '备模型完整答案');
      assert.equal(result.model, 'b');
      assert.deepEqual(log, [
        'delta:部分脏文本',
        'reset',
        'fallback:p->b:server_error',
        'delta:备模型',
        'delta:完整答案',
      ]);
    });
  });

  describe('3. 模型级三态熔断器（closed -> open -> half_open -> closed/open）', () => {
    it('连续失败触发 open 后跳过主模型，冷却期满进入 half_open 探测并支持并发隔离与恢复', async () => {
      let now = 10_000;
      const cb = new LlmCircuitBreakerService();
      cb.setClock(() => now);

      let primaryMode = 'fail';
      let primaryHits = 0;
      let releaseProbeDeferred;
      const cfg = makeConfig({
        default: 'primary',
        fallbacks: ['backup'],
        circuitBreaker: { enabled: true, failureThreshold: 2, cooldownMs: 5_000, halfOpenMaxCalls: 1 },
        models: {
          primary: {
            use: {
              async chat() {
                primaryHits++;
                if (primaryMode === 'fail') throw httpError(503);
                if (primaryMode === 'hang-probe') {
                  await new Promise(resolve => { releaseProbeDeferred = resolve; });
                  return { output: 'probe-ok' };
                }
                return { output: 'primary-recovered' };
              },
            },
          },
          backup: {
            use: {
              async chat() {
                return { output: 'backup-ok' };
              },
            },
          },
        },
      });
      const planner = new LangChainPlannerService(cfg, cb);

      // 第 1 次失败：closed（failures = 1）
      const r1 = await planner.plan([{ role: 'user', content: '1' }], []);
      assert.equal(r1.model, 'backup');
      assert.equal(cb.getState('primary').state, 'closed');
      assert.equal(primaryHits, 1);

      // 第 2 次失败：触发熔断 -> open
      const r2 = await planner.plan([{ role: 'user', content: '2' }], []);
      assert.equal(r2.model, 'backup');
      assert.equal(r2.fallbacks[0].circuitState, 'open');
      assert.equal(cb.getState('primary').state, 'open');
      assert.equal(primaryHits, 2);

      // 冷却期内（now + 2000 < 15000）：直接跳过主模型（primaryHits 不增加），记录 circuit_open
      now += 2_000;
      const r3 = await planner.plan([{ role: 'user', content: '3' }], []);
      assert.equal(r3.model, 'backup');
      assert.equal(primaryHits, 2);
      assert.equal(r3.fallbacks[0].reason, 'circuit_open');
      assert.equal(r3.fallbacks[0].code, 'LLM_CIRCUIT_OPEN');

      // 冷却到期（now = 15000）：进入 half_open，探测失败则重新 open 并刷新冷却期
      now += 3_000;
      assert.equal(cb.getState('primary').state, 'half_open');
      const r4 = await planner.plan([{ role: 'user', content: '4' }], []);
      assert.equal(r4.model, 'backup');
      assert.equal(primaryHits, 3);
      assert.equal(cb.getState('primary').state, 'open');
      assert.equal(cb.getState('primary').nextAttemptAt, 20_000);

      // 再次冷却到期：启动一个进行中的探测，期间并发请求自动跳过直走备模型；探测成功后恢复 closed
      now = 20_000;
      primaryMode = 'hang-probe';
      const probePromise = planner.plan([{ role: 'user', content: 'probe' }], []);
      await delay(10);
      assert.equal(primaryHits, 4);

      const concurrent = await planner.plan([{ role: 'user', content: 'concurrent' }], []);
      assert.equal(concurrent.model, 'backup');
      assert.equal(concurrent.fallbacks[0].reason, 'circuit_open');
      assert.equal(concurrent.fallbacks[0].circuitState, 'half_open');
      assert.equal(primaryHits, 4);

      releaseProbeDeferred();
      const probeRes = await probePromise;
      assert.equal(probeRes.model, 'primary');
      assert.equal(probeRes.finalAnswer, 'probe-ok');
      assert.equal(cb.getState('primary').state, 'closed');
      assert.equal(cb.getState('primary').consecutiveFailures, 0);

      // 全部候选模型均熔断时抛出 LlmCircuitOpenError
      const allOpenPolicy = { enabled: true, failureThreshold: 1, cooldownMs: 5_000, halfOpenMaxCalls: 1 };
      cb.recordFailure('primary', allOpenPolicy, 'LLM_SERVER_ERROR', false);
      cb.recordFailure('backup', allOpenPolicy, 'LLM_SERVER_ERROR', false);
      await assert.rejects(
        () => planner.plan([{ role: 'user', content: 'all-open' }], []),
        err => err instanceof LlmCircuitOpenError,
      );
    });
  });

  describe('4. Trace 切换步骤持久化、Agent 扫描校验与 HTTP 端到端集成', () => {
    it('Orchestrator 在 Trace 与 SSE 记录脱敏 fallback 步骤与实际 model，并透传 Agent 级参数与 fallbacks', async () => {
      const seenOpts = [];
      const cfg = makeConfig({
        default: 'primary',
        models: {
          primary: {
            use: {
              async chat(_messages, opts) {
                seenOpts.push({ model: 'primary', opts });
                throw httpError(429, 'upstream quota exceeded for sk-super-secret-key');
              },
            },
          },
          agentBackup: {
            use: {
              async chat(_messages, opts) {
                seenOpts.push({ model: 'agentBackup', opts });
                return {
                  output: 'fallback answer',
                  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
                };
              },
            },
          },
        },
      });
      const cb = new LlmCircuitBreakerService();
      const planner = new LangChainPlannerService(cfg, cb);
      const records = new Map();
      const trace = new TraceService({
        save: async run => records.set(run.runId, structuredClone(run)),
        load: async id => records.get(id) ?? null,
      });
      const agentDef = {
        name: 'resilient-agent',
        skills: [],
        tools: [],
        model: 'primary',
        fallbacks: ['agentBackup'],
        temperature: 0.7,
        maxTokens: 256,
        timeoutMs: 3000,
      };
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
        cfg,
      );

      const sseEvents = [];
      const res = await orchestrator.run('resilient-agent', 'hello', evt => sseEvents.push(evt));

      assert.equal(res.output, 'fallback answer');
      // Agent 级参数均透传
      assert.equal(seenOpts.length, 2);
      assert.equal(seenOpts[0].opts.temperature, 0.7);
      assert.equal(seenOpts[0].opts.maxTokens, 256);
      assert.equal(seenOpts[0].opts.timeoutMs, 3000);
      assert.equal(seenOpts[1].opts.temperature, 0.7);

      // Trace 中持久化脱敏的 fallback 步骤 + 后续 plan 步骤标注 model='agentBackup'
      const saved = records.get(res.runId);
      const fbStep = saved.steps.find(s => s.type === 'fallback');
      assert.ok(fbStep);
      assert.equal(fbStep.node, 'plan');
      assert.equal(fbStep.name, 'primary->agentBackup');
      assert.equal(fbStep.model, 'agentBackup');
      assert.equal(fbStep.output.fromModel, 'primary');
      assert.equal(fbStep.output.toModel, 'agentBackup');
      assert.equal(fbStep.output.reason, 'rate_limit');
      assert.equal(fbStep.output.statusCode, 429);
      assert.equal(fbStep.error.code, 'LLM_RATE_LIMITED');
      assert.doesNotMatch(JSON.stringify(saved), /sk-super-secret-key/);

      const planStep = saved.steps.find(s => s.type === 'plan');
      assert.equal(planStep.model, 'agentBackup');

      // SSE 实时推送了 fallback 步骤
      assert.ok(sseEvents.some(e => e.type === 'step' && e.step.type === 'fallback'));

      // plan-and-execute 模式的 make-plan / synthesize 节点同样记录 fallback 步骤与 model
      const planExecAgent = {
        name: 'pe-resilient',
        mode: 'plan-and-execute',
        skills: [],
        tools: [],
        model: 'primary',
        fallbacks: ['agentBackup'],
      };
      const peCfg = makeConfig({
        default: 'primary',
        circuitBreaker: { enabled: false },
        models: {
          primary: {
            use: {
              async chat() {
                throw httpError(503, 'primary down');
              },
            },
          },
          agentBackup: {
            use: {
              async chat(messages) {
                const last = messages.at(-1).content;
                if (last.includes('ordered execution plan')) return { output: '["step one"]' };
                if (last.includes('Work only on step')) return { output: 'step one done' };
                return { output: 'synthesized answer' };
              },
            },
          },
        },
      });
      const peOrchestrator = new LangGraphOrchestratorService(
        { get: name => (name === planExecAgent.name ? planExecAgent : undefined) },
        { get: () => undefined },
        { get: () => undefined },
        new LangChainPlannerService(peCfg),
        new ExecutorService({ get: () => undefined }, { get: () => undefined }),
        trace,
        new ThreadService({ get: () => false }),
        new CheckpointService({ save: async () => {}, load: async () => null }),
        { check: () => ({ safe: true }) },
        peCfg,
      );
      const peRes = await peOrchestrator.run('pe-resilient', 'run plan');
      assert.equal(peRes.output, 'synthesized answer');
      const peFallbackNodes = peRes.steps.filter(s => s.type === 'fallback').map(s => s.node);
      assert.deepEqual(peFallbackNodes, ['make-plan', 'plan', 'synthesize']);
      assert.ok(peRes.steps.filter(s => s.type === 'plan').every(s => s.model === 'agentBackup'));
    });

    it('POST /api/ai/chat、POST /api/ai/chat/stream 与 GET /api/ai/agent/config 完整走弹性容错', async () => {
      const fixture = await mkdtemp(join(tmpdir(), 'e04-http-'));
      const app = await NestFactory.create(AppModule.register({
        ai: {
          access: {
            keys: {
              ops: { secret: 'e04-secret-key', scope: 'e04-scope' },
            },
          },
          store: {
            trace: join(fixture, 'trace'),
            memory: { path: join(fixture, 'memory') },
            vector: { path: join(fixture, 'vectors.json') },
          },
          llm: {
            default: 'primary',
            fallbacks: ['backup'],
            circuitBreaker: { enabled: true, failureThreshold: 2, cooldownMs: 10_000, halfOpenMaxCalls: 1 },
            models: {
              primary: {
                use: {
                  chat(_messages, opts) {
                    if (opts?.stream) {
                      return (async function* () {
                        yield '半截文本';
                        throw httpError(503, 'primary stream broken');
                      })();
                    }
                    return Promise.reject(httpError(429, 'primary rate limited'));
                  },
                },
              },
              backup: {
                use: {
                  chat(_messages, opts) {
                    if (opts?.stream) {
                      return (async function* () {
                        yield '备用';
                        yield '流答案';
                      })();
                    }
                    return Promise.resolve({ output: 'backup-chat-ok' });
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

        const signed = (method, url, body = '') => {
          const time = String(Date.now());
          const nonce = randomUUID();
          const digest = createHash('sha256').update(body).digest('hex');
          const sig = createHmac('sha256', 'e04-secret-key')
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

        // 1) POST /api/ai/chat 遇 429 自动切备
        const chatRes = await signed('POST', '/api/ai/chat', JSON.stringify({ message: 'ping' }));
        assert.equal(chatRes.status, 201);
        assert.equal(JSON.parse(chatRes.body).output, 'backup-chat-ok');

        // 2) POST /api/ai/chat/stream 中途 503 自动发出 delta_reset 并切备完成输出
        const streamRes = await signed('POST', '/api/ai/chat/stream', JSON.stringify({ message: 'ping' }));
        assert.equal(streamRes.status, 201);
        assert.match(streamRes.body, /event: delta\ndata: \{"content":"半截文本"\}/);
        assert.match(streamRes.body, /event: delta_reset\ndata: \{\}/);
        assert.match(streamRes.body, /event: done\ndata: \{"output":"备用流答案"\}/);

        // 3) GET /api/ai/agent/config 脱敏展示 fallbacks 与 circuitBreaker
        const time = String(Date.now());
        const legacySign = createHash('md5').update('klx05hb3n1c9ujp8uhxbs2ikkiowp212_' + time).digest('hex');
        const cfgRes = await dispatch(app, 'GET', '/api/ai/agent/config', { s_t: time, s_sign: legacySign });
        assert.equal(cfgRes.status, 200);
        const publicConfig = JSON.parse(cfgRes.body);
        assert.deepEqual(publicConfig.llm.fallbacks, ['backup']);
        assert.deepEqual(publicConfig.llm.circuitBreaker, {
          enabled: true,
          failureThreshold: 2,
          cooldownMs: 10_000,
          halfOpenMaxCalls: 1,
        });
      } finally {
        await app.close();
        await rm(fixture, { recursive: true, force: true });
      }
    });

    it('AgentScannerService 正确校验新增 fallbacks 与推理参数声明', async () => {
      const fixture = await mkdtemp(join(tmpdir(), 'e04-scanner-'));
      const agentsDir = join(fixture, 'dist', 'agents');
      await mkdir(agentsDir, { recursive: true });
      const prevCwd = process.cwd();

      try {
        await writeFile(
          join(agentsDir, 'valid.agent.js'),
          `module.exports = { default: {
            name: 'valid-resilient',
            skills: [],
            tools: [],
            model: 'primary',
            fallbacks: ['backup'],
            temperature: 0.3,
            maxTokens: 1024,
            topP: 0.95,
            timeoutMs: 15000,
          } };`,
        );
        process.chdir(fixture);
        const scanner = new AgentScannerService();
        scanner.onModuleInit();
        const loaded = scanner.get('valid-resilient');
        assert.ok(loaded);
        assert.deepEqual(loaded.fallbacks, ['backup']);
        assert.equal(loaded.temperature, 0.3);
        assert.equal(loaded.maxTokens, 1024);

        // 非法 temperature 应在启动扫描阶段立即拒绝
        await writeFile(
          join(agentsDir, 'bad.agent.js'),
          `module.exports = { default: { name: 'bad-agent', skills: [], tools: [], temperature: -1 } };`,
        );
        const badScanner = new AgentScannerService();
        assert.throws(() => badScanner.onModuleInit(), /Invalid default AgentDefinition export/);
      } finally {
        process.chdir(prevCwd);
        await rm(fixture, { recursive: true, force: true });
      }
    });
  });
});
