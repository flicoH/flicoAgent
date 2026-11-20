const assert = require('node:assert/strict');
const { AiController } = require('../../dist/ai/ai.controller');
const { LangChainPlannerService } = require('../../dist/ai/runtime/langchain/langchain-planner.service');
const { LangGraphOrchestratorService } = require('../../dist/ai/runtime/langgraph/langgraph-orchestrator.service');
const { ExecutorService } = require('../../dist/ai/tool/executor.service');
const { ThreadService } = require('../../dist/ai/memory/thread.service');
const { TraceService } = require('../../dist/ai/trace/trace.service');

const definition = (name, extras = {}) => ({ name, skills: [], tools: [], ...extras });
const text = output => ({ output, usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } });
const call = (name, args) => ({
  output: '',
  message: {
    role: 'assistant', content: null,
    tool_calls: [{ id: 'call-' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  },
});

function setup(chat, definitions, limits = {}, registeredTools = {}) {
  const agents = { get: name => definitions.find(agent => agent.name === name) };
  const values = {
    'ai.llm': { default: 'fixture', models: { fixture: { use: { chat: async (...args) => chat(...args) } } } },
    'agentConfig.threadEnabled': false,
    ...limits,
  };
  const config = { get: key => values[key] };
  const skills = { get: () => undefined };
  const tools = { get: name => registeredTools[name] };
  const records = new Map();
  const trace = new TraceService({
    save: async run => records.set(run.runId, structuredClone(run)),
    load: async id => records.has(id) ? structuredClone(records.get(id)) : null,
  });
  const runtime = new LangGraphOrchestratorService(
    agents, skills, tools, new LangChainPlannerService(config), new ExecutorService(skills, tools),
    trace, new ThreadService(config), {}, { check: () => ({ safe: true }) }, config,
  );
  return { runtime, controller: new AiController(tools, agents, runtime, trace, config), trace };
}

describe('Agent loop modes', () => {
  it('defaults to ReAct and exposes the selected graph', async () => {
    const { controller } = setup(() => text('direct answer'), [definition('default')]);
    const { data } = await controller.runAgent({ agent: 'default', input: 'question' });
    assert.equal(data.output, 'direct answer');
    assert.deepEqual(data.steps.map(step => step.node), ['plan', 'plan']);
    assert.deepEqual(controller.getAgentGraph(), controller.getAgentGraph('react'));
    assert.ok(controller.getAgentGraph('reflection').nodes.some(node => node.id === 'review'));
    assert.ok(controller.getAgentGraph('plan-and-execute').nodes.some(node => node.id === 'synthesize'));
    assert.throws(() => controller.getAgentGraph('unknown'), { status: 400 });
  });

  it('plans first, executes the ordered steps and synthesizes their results', async () => {
    const executed = [];
    const agent = definition('planned', { mode: 'plan-and-execute', tools: ['lookup'] });
    const { runtime, trace } = setup((messages, { tools }) => {
      const last = messages.at(-1);
      if (last.content.startsWith('Create an ordered')) {
        assert.deepEqual(tools, []);
        return text('["Read a value", "Interpret the value"]');
      }
      if (last.content.startsWith('Work only on step 1')) return call('lookup', { id: 5 });
      if (last.role === 'tool') {
        assert.equal(last.tool_call_id, 'call-lookup');
        return text('Read 42');
      }
      if (last.content.startsWith('Work only on step 2')) {
        assert.equal(messages.at(-2).content, 'Read 42');
        return text('Interpreted 42');
      }
      assert.match(last.content, /^Answer the original/);
      assert.equal(messages.at(-2).content, 'Interpreted 42');
      assert.deepEqual(tools, []);
      return text('The final answer is 42');
    }, [agent], {}, {
      lookup: {
        name: 'lookup', description: 'Read a value', inputSchema: { type: 'object' },
        execute: async input => { executed.push(input.id); return 42; },
      },
    });
    const result = await runtime.run('planned', 'What is the value?');
    assert.deepEqual(executed, [5]);
    assert.equal(result.output, 'The final answer is 42');
    assert.deepEqual(result.steps[0].output, ['Read a value', 'Interpret the value']);
    assert.equal(result.steps.at(-2).node, 'synthesize');
    assert.equal((await trace.load(result.runId)).usage.totalTokens, 12);
  });

  it('reviews drafts and streams the approved revision', async () => {
    const agent = definition('reviewed', { mode: 'reflection' });
    const { runtime } = setup((messages, { tools }) => {
      const last = messages.at(-1).content;
      if (last.startsWith('Review the latest')) {
        assert.deepEqual(tools, []);
        return text(messages.at(-2).content === 'first draft'
          ? '{"approved":false,"feedback":"Include the conclusion"}'
          : '{"approved":true,"feedback":""}');
      }
      if (last.startsWith('Revise the previous')) {
        assert.match(last, /Include the conclusion/);
        return text('revised answer');
      }
      return text('first draft');
    }, [agent]);
    const events = [];
    const result = await runtime.run('reviewed', 'question', event => events.push(event));
    assert.equal(result.output, 'revised answer');
    assert.equal(events.filter(event => event.type === 'delta').map(event => event.content).join(''), 'revised answer');
    assert.deepEqual(result.steps.filter(step => step.node === 'review').map(step => step.output.approved), [false, true]);
    assert.equal(result.usage.totalTokens, 12);
  });

  it('reports invalid plans and stops reflection when its revision limit is reached', async () => {
    const { runtime } = setup(messages => {
      const last = messages.at(-1).content;
      if (last.startsWith('Create an ordered')) return call('forged_tool', {});
      if (last.startsWith('Review the latest')) return text('{"approved":false,"feedback":"Add evidence"}');
      return text('draft');
    }, [
      definition('planned', { mode: 'plan-and-execute' }),
      definition('reviewed', { mode: 'reflection', maxReflectionRevisions: 0 }),
    ]);
    const planned = await runtime.run('planned', 'question');
    assert.equal(planned.steps.length, 1);
    assert.equal(planned.steps[0].error.code, 'INVALID_TASK_PLAN');
    const reviewed = await runtime.run('reviewed', 'question');
    assert.equal(reviewed.output, 'draft');
    assert.equal(reviewed.steps.find(step => step.node === 'review').error.code, 'REFLECTION_LIMIT');
    assert.equal(reviewed.steps.filter(step => step.usage).length, 2);
  });

  it('counts review calls against the shared delegation budget', async () => {
    let modelCalls = 0;
    const { runtime, trace } = setup(messages => {
      modelCalls++;
      return messages.at(-1).content === 'root input'
        ? call('agent-delegate', { agent: 'child', input: 'child input' })
        : text('draft');
    }, [
      definition('root', { delegates: ['child'] }),
      definition('child', { mode: 'reflection' }),
    ], { 'ai.runtime.delegation.maxModelCalls': 2 });
    const result = await runtime.run('root', 'root input');
    const delegation = result.steps.find(step => step.childRunId);
    const child = await trace.load(delegation.childRunId);
    assert.equal(child.steps.at(-1).node, 'review');
    assert.equal(child.steps.at(-1).error.code, 'DELEGATE_BUDGET_EXCEEDED');
    assert.equal(delegation.error.code, 'DELEGATE_BUDGET_EXCEEDED');
    assert.equal(modelCalls, 2);
  });
});
