# Agent Delegation Guide

[中文](agent-delegation.md) | English

A parent Agent declares directly callable child targets via `delegates`. The framework exposes the reserved tool `agent-delegate` accepting `{ agent, input }`, where `input` is a non-empty string. Each child Agent uses its own model, prompt, and Skill/Tool allowlist, creates an isolated Trace and thread, and receives only the delegated input. Child runs still pass through Guardrail. Capabilities requiring human approval return `DELEGATE_APPROVAL_REQUIRED` inside delegated runs.

| Config Key | Default | Accounting |
| --- | --- | --- |
| `ai.runtime.delegation.maxDepth` | `2` | Root run has depth `0`. Set `0` to disable delegation |
| `ai.runtime.delegation.maxChildRuns` | `4` | Total child runs created across the entire run tree. Set `0` to disable delegation |
| `ai.runtime.delegation.maxModelCalls` | `ai.runtime.maxIterations + 10` | Shared model call budget across root and all child runs (minimum `1`) |

`ai.runtime.maxIterations` still bounds each Agent's own planning turns. Model call budgets count individual calls. Targets must appear in the calling Agent's `delegates` list and cannot revisit an ancestor in the current chain. Setting `delegationOnly: true` prevents running that Agent directly through synchronous or streaming APIs.

The business auth layer can set `request.agentRunAccess = { scope, agents }` on the server. Runs and Trace lookups use this scope; child runs inherit `scope` and enforce the caller's `agents` allowlist at every level. When memory is enabled, the same `threadId` uses isolated checkpoints per `scope`. Both fields are optional. The example below validates delegation constraints using Agent declarations; if your auth layer also configures an `agents` allowlist, grant access to both parent and child Agents for the test caller.

## 1. Add Two Test Agents

Add the following files to a business project using `@flicoh/agent` (with delegation support; if depending on local source, run `npm run build` in the framework directory first).

`app/agents/delegation-parent.agent.ts`

```ts
import type { AgentDefinition } from '@flicoh/agent';

export default {
  name: 'delegation-parent',
  model: 'delegation-fixture',
  delegates: ['delegation-child'],
  skills: [],
  tools: [],
} satisfies AgentDefinition;
```

`app/agents/delegation-child.agent.ts`

```ts
import type { AgentDefinition } from '@flicoh/agent';

export default {
  name: 'delegation-child',
  model: 'delegation-child-fixture',
  delegationOnly: true,
  skills: [],
  tools: [],
} satisfies AgentDefinition;
```

## 2. Start Offline Models from the Business Project Root

Build the business project so both declarations compile to `dist/agents/*.agent.js`, then run the command below. It registers two offline test models: the parent always triggers a tool call (requesting an undeclared target when input is `'deny'`), and the child returns fixed text.

```sh
_ENV=local node <<'JS'
class DelegationFixture {
  async chat(messages) {
    const last = messages.at(-1);
    if (last.role === 'tool') return { output: last.content };

    const agent = last.content === 'deny' ? 'undeclared-agent' : 'delegation-child';
    return {
      output: '',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'delegation-test-1',
          type: 'function',
          function: {
            name: 'agent-delegate',
            arguments: JSON.stringify({ agent, input: 'offline subtask' }),
          },
        }],
      },
    };
  }
}

require('@flicoh/agent').serverStart({
  ai: {
    mcp: { enabled: false },
    llm: {
      models: {
        'delegation-fixture': { use: DelegationFixture },
        'delegation-child-fixture': {
          use: { chat: async () => ({ output: 'Offline child answer' }) },
        },
      },
    },
  },
});
JS
```

## 3. Run and Inspect Traces

In another terminal, execute the script below. It targets `http://127.0.0.1:8080` by default (override via `AGENT_TEST_URL`). Configure headers to match your project's authentication:

- For framework `s_t` / `s_sign` verification, set `AGENT_TEST_SIGN_KEY` to your test environment's signing key.
- For session-based auth, obtain test credentials first and pass JSON headers via `AGENT_TEST_HEADERS`, e.g. `{"Cookie":"<test session cookie>"}`. If your app requires per-request custom headers, add signing logic inside `request()`.

```sh
node <<'JS'
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const signKey = process.env.AGENT_TEST_SIGN_KEY;
const base = process.env.AGENT_TEST_URL || 'http://127.0.0.1:8080';
const extraHeaders = JSON.parse(process.env.AGENT_TEST_HEADERS || '{}');

function request(path, body) {
  const headers = new Headers({ 'Content-Type': 'application/json', ...extraHeaders });
  if (signKey) {
    const s_t = String(Date.now());
    headers.set('s_t', s_t);
    headers.set('s_sign', createHash('md5').update(signKey + '_' + s_t).digest('hex'));
  }
  return fetch(new URL(path, base), {
    method: body ? 'POST' : 'GET',
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function main() {
  const path = '/api/ai/agent/run';
  const execute = async input => {
    const response = await request(path, { agent: 'delegation-parent', input });
    const result = await response.json();
    assert.equal(result.success, true, JSON.stringify(result));
    return result.data;
  };

  const parent = await execute('test delegation');
  const step = parent.steps.find(item => item.name === 'agent-delegate' && item.childRunId);
  assert.ok(step, 'Parent trace is missing a child run ID');
  const response = await request('/api/ai/trace/' + step.childRunId);
  const { data: child } = await response.json();
  assert.equal(child.parentRunId, parent.runId);
  assert.equal(child.rootRunId, parent.runId);
  assert.equal(child.delegationDepth, 1);
  assert.notEqual(child.threadId, parent.threadId);
  assert.equal(child.output, 'Offline child answer');

  const denied = await execute('deny');
  assert.ok(denied.steps.some(item => item.error?.code === 'DELEGATE_NOT_ALLOWED'));
  assert.ok(!denied.steps.some(item => item.childRunId));

  const direct = await request(path, { agent: 'delegation-child', input: 'direct' });
  assert.equal(direct.status, 403);
  const stream = await request(path + '/stream', { agent: 'delegation-parent', input: 'stream' });
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  assert.match(await stream.text(), /"childRunId"/);

  console.log({ parentRunId: parent.runId, childRunId: child.runId, output: child.output });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
JS
```

To verify budget rejections, add `runtime: { delegation: { maxChildRuns: 0 } }` under `ai` in the bootstrap options, restart, and call the parent Agent: the step should record `DELEGATE_BUDGET_EXCEEDED` with no `childRunId`. Use `maxDepth: 0` to verify `DELEGATE_DEPTH_EXCEEDED`, or `maxModelCalls: 1` to verify that exhausting the model call budget prevents creating child runs.
