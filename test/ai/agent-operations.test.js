const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { mkdtemp, mkdir, realpath, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');
const { LangGraphOrchestratorService } = require('../../dist/ai/runtime/langgraph/langgraph-orchestrator.service');
const { ExecutorService, CapabilityApprovalRequired } = require('../../dist/ai/tool/executor.service');
const { FileTraceStore } = require('../../dist/ai/store/reference/file-trace.store');
const { FileVectorStore } = require('../../dist/ai/store/reference/file-vector.store');
const { TraceService } = require('../../dist/ai/trace/trace.service');
const { RetrieverService } = require('../../dist/ai/rag/retriever.service');
const { retrievalOutput } = require('../../dist/ai/rag/citations');
const { ThreadService } = require('../../dist/ai/memory/thread.service');
const { CheckpointService } = require('../../dist/ai/memory/checkpoint.service');
const { parseSuite, runSuite } = require('../../dist/ai/eval/run-suite');

const call = (name, args = {}) => ({ id: 'call-' + name, name, args });
const definition = (name, execute, approval) => ({
  name, execute, approval, description: name, inputSchema: { type: 'object' },
});

async function waitFor(orchestrator, id, status) {
  for (let i = 0; i < 80; i++) {
    const run = await orchestrator.find(id);
    if (run?.status === status) return run;
    await delay(10);
  }
  assert.fail('Expected ' + status + ', got ' + (await orchestrator.find(id))?.status);
}

describe('SDD Agent 运维能力', () => {
  let root;
  beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-'))); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  function harness(planner, agents, skills = {}, tools = {}, { memory = false } = {}) {
    const registry = { get: name => skills[name] };
    const toolRegistry = { get: name => tools[name] };
    const trace = new TraceService(new FileTraceStore(root));
    const config = { get: key => key === 'agentConfig.threadEnabled' ? memory : undefined };
    const executor = new ExecutorService(registry, toolRegistry);
    const checkpoints = new Map();
    const service = new LangGraphOrchestratorService(
      { get: name => agents[name] }, registry, toolRegistry, { plan: planner }, executor, trace,
      new ThreadService(config), new CheckpointService({
        load: async id => checkpoints.get(id) ?? null,
        save: async state => checkpoints.set(state.threadId, state),
      }), { check: () => ({ safe: true }) }, config,
    );
    return { service, executor, trace };
  }

  it('审批挂起跨重启恢复；已执行的同轮工具不重复，拒绝不触发外部操作', async () => {
    const executed = [];
    const skills = {
      read: definition('read', async () => executed.push('read')),
      write: definition('write', async () => executed.push('write'), 'required'),
      next: definition('next', async () => executed.push('next'), 'required'),
    };
    const agents = { root: { name: 'root', skills: ['read', 'write', 'next'], tools: [] } };
    const planner = async messages => {
      if (!messages.some(message => message.role === 'tool')) {
        return { toolCalls: [call('read'), call('write'), call('next')], usage: { totalTokens: 3 } };
      }
      assert.deepEqual(messages.filter(m => m.role === 'tool').map(m => m.tool_call_id),
        ['call-read', 'call-write', 'call-next']);
      assert.match(messages.at(-1).content, /APPROVAL_REJECTED/);
      return { finalAnswer: 'done', usage: { totalTokens: 2 } };
    };
    const first = harness(planner, agents, skills);
    const paused = await first.service.run('root', 'input', undefined, undefined, { scope: 'tenant' });
    assert.equal(paused.status, 'waiting_approval');
    assert.deepEqual(executed, ['read']);
    assert.equal(paused.approval.name, 'write');
    assert.equal(paused.usage.totalTokens, 3);
    assert.throws(() => first.executor.invokeSkill(skills.write, {}, {}), CapabilityApprovalRequired);

    const restarted = harness(planner, agents, skills).service;
    await restarted.decide(paused.runId, paused.approval.id, true);
    const second = await waitFor(restarted, paused.runId, 'waiting_approval');
    assert.equal(second.approval.name, 'next');
    await assert.rejects(restarted.decide(paused.runId, paused.approval.id, true), { status: 409 });
    await restarted.decide(paused.runId, second.approval.id, false);
    const result = await waitFor(restarted, paused.runId, 'succeeded');
    assert.deepEqual(executed, ['read', 'write']);
    assert.equal(result.output, 'done');
    assert.equal(result.steps.filter(s => s.type === 'approval').length, 2);
    assert.equal(result.usage.totalTokens, 5);
    assert.ok(Number.isFinite(result.modelDurationMs));
    assert.equal(result.continuation, undefined);
  });

  it('等待审批期间可提交同线程的新轮次，恢复不会覆盖较新的对话', async () => {
    const skill = definition('write', async () => 'saved', 'required');
    const { service } = harness(async messages => {
      if (messages.at(-1).role === 'tool') return { finalAnswer: 'old answer' };
      if (messages.at(-1).content === 'old input') return { toolCalls: [call('write')] };
      if (messages.at(-1).content === 'recall') {
        assert.deepEqual(messages.map(m => m.content), ['new input', 'new answer', 'recall']);
      }
      return { finalAnswer: 'new answer' };
    }, { root: { name: 'root', skills: ['write'], tools: [] } }, { write: skill }, {}, { memory: true });
    const paused = await service.run('root', 'old input', 'shared');
    assert.equal(paused.status, 'waiting_approval');
    assert.equal((await service.run('root', 'new input', 'shared')).status, 'succeeded');
    await service.decide(paused.runId, paused.approval.id, true);
    await waitFor(service, paused.runId, 'succeeded');
    assert.equal((await service.run('root', 'recall', 'shared')).status, 'succeeded');
  });

  it('取消中止模型；后台失败和重启中断保留安全原因，列表按 scope 隔离', async () => {
    const { service, trace } = harness(async (messages, _, { signal }) => {
      if (messages.at(-1).content === 'broken') throw new Error('provider secret');
      await delay(5_000, undefined, { signal });
      return { finalAnswer: 'too late' };
    }, { root: { name: 'root', skills: [], tools: [] } });
    const running = await service.submit('root', 'cancel', undefined, { scope: 'a' });
    await waitFor(service, running.runId, 'running');
    assert.equal((await service.cancel(running.runId)).status, 'cancelled');
    const broken = await service.submit('root', 'broken', undefined, { scope: 'b' });
    const failed = await waitFor(service, broken.runId, 'failed');
    assert.equal(failed.failure.code, 'MODEL_FAILED');
    assert.doesNotMatch(JSON.stringify(failed), /provider secret/);
    const orphan = await trace.createRun('root', 'old', 'old-thread', 'a', { status: 'running', workerId: 'old' });
    assert.equal((await service.find(orphan.runId)).status, 'interrupted');
    const page = await service.list({ scope: 'a', agents: ['root'], offset: 0, limit: 5 });
    assert.deepEqual(new Set(page.map(run => run.runId)), new Set([orphan.runId, running.runId]));
  });

  it('委派保留父子 Trace，限制调用者权限、循环与四次子运行预算', async () => {
    const agents = {
      root: { name: 'root', skills: [], tools: [], delegates: ['root', 'child'] },
      child: { name: 'child', skills: [], tools: [], delegates: ['root'], prompt: 'child-only' },
    };
    const planner = async (messages, tools) => {
      const observed = messages.filter(m => m.role === 'tool');
      if (messages[0].content === 'child-only') {
        assert.equal(messages[1].content, 'subtask');
        assert.ok(!tools.some(tool => tool.name === 'agent-delegate'));
        return { finalAnswer: 'child answer' };
      }
      if (observed.length) return { finalAnswer: 'parent answer' };
      return { toolCalls: [call('agent-delegate', { agent: 'root', input: 'cycle' }),
        ...Array.from({ length: 5 }, (_, i) => ({
          ...call('agent-delegate', { agent: 'child', input: 'subtask' }), id: 'sub-' + i,
        }))] };
    };
    const { service } = harness(planner, agents);
    const result = await service.run('root', 'parent private input', undefined, undefined, { scope: 'a' });
    const children = result.steps.filter(s => s.childRunId);
    assert.equal(children.length, 4);
    assert.ok(result.steps.some(s => s.error?.code === 'DELEGATE_BUDGET_EXCEEDED'));
    for (const step of children) {
      const child = await service.find(step.childRunId);
      assert.equal(child.parentRunId, result.runId);
      assert.equal(child.rootRunId, result.runId);
      assert.equal(child.scope, 'a');
      assert.notEqual(child.threadId, result.threadId);
      assert.equal(child.output, 'child answer');
    }
    const denied = await service.run('root', 'denied', undefined, undefined, { agents: ['root'] });
    assert.equal(denied.steps.filter(s => s.error?.code === 'DELEGATE_NOT_ALLOWED').length, 6);
  });

  it('索引管理可定位切片；只把已检索且正文确实使用的标记变成 citations', async () => {
    const docs = join(root, 'docs');
    await mkdir(docs);
    await writeFile(join(docs, 'policy.txt'), 'refund within 30 days');
    const retriever = new RetrieverService(new FileVectorStore(join(root, 'vectors.json')),
      { get: key => key === 'ai.embedding' ? { use: { embed: async values => values.map(() => [1]) } } : undefined });
    await retriever.ingestFromDirectory(docs);
    assert.deepEqual(await retriever.listDocuments(docs), [{ docId: 'policy.txt', chunks: 1 }]);
    const { hits } = await retriever.preview(docs, 'refund');
    const observed = retrievalOutput(hits);
    assert.equal((await retriever.loadChunk(docs, hits[0].id)).text, 'refund within 30 days');
    assert.equal(observed.hits[0].meta.filePath, undefined);
    const planner = async messages => messages.some(m => m.role === 'tool')
      ? { finalAnswer: '退款 ' + observed.hits[0].citation + ' [cite:111111111111111111111111]' }
      : { toolCalls: [call('retrieve')] };
    const { service } = harness(planner, { root: { name: 'root', skills: [], tools: ['retrieve'] } },
      {}, { retrieve: definition('retrieve', async () => observed) });
    const result = await service.run('root', 'refund');
    assert.equal(result.citations.length, 1);
    assert.equal(result.citations[0].chunkId, hits[0].id);
    assert.equal(await retriever.deleteDocument(docs, 'policy.txt'), 1);
    assert.equal(await retriever.loadChunk(docs, hits[0].id), null);
    await retriever.ingestFromDirectory(docs);
    assert.equal((await retriever.preview(docs, 'refund')).hits.length, 1);
  });

  it('评测区分工具计划与真实执行，复用多轮线程，并正确报告授权拒绝', async () => {
    const suite = parseSuite({ cases: [
      { id: 'memory', agent: 'root', turns: [
        { input: 'hello', assert: { toolsUsed: ['lookup'], citationDocIds: ['policy.txt'] } },
        { input: 'recall', assert: { outputContains: 'hello' } },
      ] },
      { id: 'unauthorized', agent: 'private', turns: [{ input: 'hello', expectStatus: 403 }] },
      { id: 'plan-only', agent: 'root', turns: [{ input: 'plan-only', assert: { toolsUsed: ['lookup'] } }] },
    ] });
    const requests = [];
    const report = await runSuite(suite, async request => {
      requests.push(request);
      if (request.agent === 'private') return { status: 403, body: {} };
      return { status: 201, body: { success: true, data: {
        runId: 'fixture', output: 'hello',
        steps: [{ type: request.input === 'plan-only' ? 'plan' : 'tool', name: 'lookup' }],
        citations: [{ docId: 'policy.txt', chunkId: 'chunk' }],
      } } };
    });
    assert.equal(report.passed, 2);
    assert.equal(report.failed, 1);
    assert.equal(requests[0].threadId, requests[1].threadId);
    assert.notEqual(requests[1].threadId, requests[2].threadId);
    assert.ok(!JSON.stringify(report).includes('hello'));
  });

  it('评测 CLI 用退出码区分通过、断言失败、无效用例和报告写入失败', async () => {
    const suite = join(root, 'suite.json');
    const fetchFixture = join(root, 'fetch.cjs');
    const cli = join(__dirname, '../../dist/ai/eval/cli.js');
    const run = (...flags) => promisify(execFile)(process.execPath, [
      '--require', fetchFixture, cli, '--suite', suite, '--url', 'http://localhost:8080', ...flags,
    ], { env: { ...process.env, AGENT_EVAL_KEY_ID: 'fixture', AGENT_EVAL_SECRET: 'fixture-key' } });
    const writeSuite = expectation => writeFile(suite, JSON.stringify({ cases: [
      { id: 'answer', agent: 'fixture', turns: [{ input: 'test', assert: { outputContains: expectation } }] },
    ] }));

    await writeFile(fetchFixture, `global.fetch = async () => Response.json({ success: true,
      data: { runId: 'fixture', output: 'answer', steps: [] },
    });`);
    await writeSuite('answer');
    const success = await run();
    assert.equal(JSON.parse(success.stdout).passed, 1);
    await assert.rejects(run('--out', join(root, 'missing', 'report.json')), error => {
      assert.equal(error.code, 30);
      assert.match(error.stderr, /Could not write the JSON report/);
      return true;
    });

    await writeSuite('expected answer');
    await assert.rejects(run(), error => {
      assert.equal(error.code, 10);
      assert.equal(JSON.parse(error.stdout).failed, 1);
      return true;
    });

    await writeFile(suite, 'invalid json');
    await assert.rejects(run(), { code: 20 });
  });
});
