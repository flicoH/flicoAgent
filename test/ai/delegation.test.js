const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { AiController } = require('../../dist/ai/ai.controller');
const { LangGraphOrchestratorService } = require('../../dist/ai/runtime/langgraph/langgraph-orchestrator.service');
const { ExecutorService } = require('../../dist/ai/tool/executor.service');
const { TraceService } = require('../../dist/ai/trace/trace.service');
const { ThreadService } = require('../../dist/ai/memory/thread.service');

const toolCall = (name, args = {}, id = name) => ({ name, args, id });
const delegate = (agent, input = 'subtask', id) => toolCall('agent-delegate', { agent, input }, id);
const agent = (name, delegates = [], extra = {}) => ({ name, delegates, skills: [], tools: [], ...extra });

function setup(planner, definitions, limits = {}, skills = {}, guardrail = () => ({ safe: true })) {
  const values = { threadEnabled: false, ...limits };
  const config = { get: key => values[key.split('.').at(-1)] };
  const agents = { get: name => definitions.find(item => item.name === name) };
  const skillRegistry = { get: name => skills[name] };
  const tools = { get: () => undefined };
  const runs = new Map();
  const trace = new TraceService({
    save: async run => runs.set(run.runId, structuredClone(run)),
    load: async id => runs.has(id) ? structuredClone(runs.get(id)) : null,
  });
  const threadService = new ThreadService(config);
  const scopedId = 'agent-scope-' + createHash('sha256')
    .update(JSON.stringify(['tenant', 'parent-thread'])).digest('hex');
  const checkpoints = {
    load: async id => id === scopedId ? { threadId: id, messages: [{ role: 'user', content: 'parent history' }] } : null,
    save: async state => assert.equal(state.threadId, scopedId),
  };
  const service = new LangGraphOrchestratorService(
    agents, skillRegistry, tools, { plan: planner }, new ExecutorService(skillRegistry, tools),
    trace, threadService, checkpoints, { check: guardrail }, config,
  );
  return { service, trace, runs, controller: new AiController(tools, agents, service, trace, config) };
}

describe('Agent delegation', () => {
  it('links nested runs in both directions and isolates child memory', async () => {
    const definitions = [
      agent('root', ['child']),
      agent('child', ['leaf'], { delegationOnly: true }),
      agent('leaf', []),
    ];
    const { service, trace, controller } = setup(async (messages, tools) => {
      const last = messages.at(-1);
      if (last.role === 'tool') return { finalAnswer: JSON.parse(last.content).output.output };
      if (last.content === 'parent task') {
        assert.equal(messages[0].content, 'parent history');
        assert.deepEqual(tools[0].schema.properties.agent.enum, ['child']);
        return { toolCalls: [delegate('child')] };
      }
      assert.equal(messages.length, 1);
      if (last.content === 'subtask') return { toolCalls: [delegate('leaf', 'leaf task')] };
      return { finalAnswer: 'leaf answer' };
    }, definitions, { threadEnabled: true });
    const access = { scope: 'tenant', agents: ['root', 'child', 'leaf'] };
    const result = await service.run('root', 'parent task', 'parent-thread', undefined, access);
    const child = await trace.load(result.steps.find(step => step.childRunId).childRunId);
    const leaf = await trace.load(child.steps.find(step => step.childRunId).childRunId);
    assert.equal(result.output, 'leaf answer');
    assert.equal(child.parentRunId, result.runId);
    assert.equal(leaf.parentRunId, child.runId);
    assert.equal(leaf.rootRunId, result.runId);
    assert.equal(leaf.delegationDepth, 2);
    assert.equal(child.scope, 'tenant');
    assert.equal(new Set([result.threadId, child.threadId, leaf.threadId]).size, 3);
    const response = await controller.getTrace(child.runId, { agentRunAccess: access });
    assert.equal(response.data.parentRunId, result.runId);
    assert.equal(response.data.scope, undefined);
    await assert.rejects(controller.getTrace(child.runId, { agentRunAccess: { scope: 'other' } }));
    await assert.rejects(service.run('child', 'direct', undefined, undefined, access), { status: 403 });
    const stream = service.runStream('child', 'direct', undefined, access);
    await assert.rejects(stream.next(), { status: 403 });
  });

  it('rejects forged targets, cycles and excess children even in one model response', async () => {
    const definitions = [agent('root', ['root', 'child']), agent('child'), agent('other')];
    const { service, runs } = setup(async (messages, tools) => {
      if (messages.at(-1).role === 'tool') return { finalAnswer: 'done' };
      if (messages.at(-1).content === 'subtask') return { finalAnswer: 'child' };
      if (messages.at(-1).content === 'denied') assert.equal(tools.length, 0);
      return { toolCalls: [
        delegate('other'), delegate('root'),
        ...Array.from({ length: 5 }, (_, i) => delegate('child', 'subtask', 'child-' + i)),
      ] };
    }, definitions);
    const result = await service.run('root', 'test');
    assert.deepEqual(result.steps.filter(step => step.error).map(step => step.error.code),
      ['DELEGATE_NOT_ALLOWED', 'DELEGATE_CYCLE', 'DELEGATE_BUDGET_EXCEEDED']);
    assert.equal(result.steps.filter(step => step.childRunId).length, 4);
    assert.equal(runs.size, 5);
    const denied = await service.run('root', 'denied', undefined, undefined, { agents: ['root'] });
    assert.equal(denied.steps.filter(step => step.error?.code === 'DELEGATE_NOT_ALLOWED').length, 6);
    assert.equal(runs.size, 6);
  });

  it('enforces shared model budget and depth while recording child guardrail and capability denials', async () => {
    const definitions = [
      agent('root', ['child']),
      agent('child', ['leaf'], { skills: ['approval'] }),
      agent('leaf'),
    ];
    let modelCalls = 0;
    let executions = 0;
    const skill = { execute: async () => executions++, inputSchema: { type: 'object' } };
    const { service, trace } = setup(async messages => {
      modelCalls++;
      if (messages.at(-1).content === 'root task') return { toolCalls: [
        delegate('child', 'blocked', 'blocked'),
        delegate('child', 'child task', 'child'),
      ] };
      return { toolCalls: [delegate('leaf'), toolCall('hidden'), toolCall('approval')] };
    }, definitions, { maxDepth: 1, maxModelCalls: 2 }, {
      hidden: skill, approval: { ...skill, approval: 'required' },
    }, input => ({ safe: input !== 'blocked' }));
    const result = await service.run('root', 'root task');
    const [guard, child] = result.steps.filter(step => step.childRunId);
    assert.equal(guard.error.code, 'DELEGATE_GUARDRAIL');
    assert.equal((await trace.load(guard.childRunId)).parentRunId, result.runId);
    const childTrace = await trace.load(child.childRunId);
    assert.deepEqual(childTrace.steps.filter(step => step.error).map(step => step.error.code), [
      'DELEGATE_DEPTH_EXCEEDED', 'CAPABILITY_NOT_ALLOWED', 'DELEGATE_APPROVAL_REQUIRED', 'DELEGATE_BUDGET_EXCEEDED',
    ]);
    assert.equal(result.steps.at(-1).error.code, 'DELEGATE_BUDGET_EXCEEDED');
    assert.equal(modelCalls, 2);
    assert.equal(executions, 0);
  });
});
