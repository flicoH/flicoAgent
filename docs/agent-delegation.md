# Agent 委派接入示例

中文 | [English](agent-delegation.en.md)

父 Agent 用 `delegates` 声明允许直接调用的目标。框架向模型提供 `agent-delegate`，参数为 `{ agent, input }`，其中 `input` 是非空文本。子 Agent 使用自己的模型、提示词和 Skill/Tool 白名单，独立创建 Trace 和线程，仅接收委派输入。子运行仍经过 Guardrail。需要人工审批的能力在子运行中返回 `DELEGATE_APPROVAL_REQUIRED`。

| 配置项 | 默认值 | 计数方式 |
| --- | --- | --- |
| `ai.runtime.delegation.maxDepth` | 2 | 根运行深度为 0。设为 0 可禁用委派 |
| `ai.runtime.delegation.maxChildRuns` | 4 | 整棵运行树累计创建的子运行。设为 0 可禁用委派 |
| `ai.runtime.delegation.maxModelCalls` | `ai.runtime.maxIterations + 10` | 根运行和所有子运行共享的模型调用次数，最小值为 1 |

`ai.runtime.maxIterations` 仍限制每个 Agent 自己的规划轮数。模型调用预算按调用次数计。子目标须在当前 Agent 的 `delegates` 中，且不能重复访问当前链路中的祖先。声明 `delegationOnly: true` 可禁止直接通过同步或流式接口运行该 Agent。

业务鉴权层可以在服务端设置 `request.agentRunAccess = { scope, agents }`。运行和 Trace 查询会使用这个范围，子运行继承 scope，逐级检查调用者的 Agent 白名单。启用历史记忆时，同一个 threadId 在不同 scope 中使用独立的检查点。两个字段均可选。下面的示例通过 Agent 声明验证调用限制。若业务鉴权层也配置了 Agent 白名单，请为测试调用方授权父、子两个 Agent。

## 1. 添加两个测试 Agent

在已接入 `@flicoh/agent` 的业务工程中添加以下文件。请使用包含委派功能的框架版本。如果使用本地源码作为依赖，先在框架目录执行 `npm run build`。

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

## 2. 在业务工程根目录启动离线模型

先运行业务工程的构建命令，确认两个声明编译为 `dist/agents/` 下的 `*.agent.js`，再运行以下启动命令。命令注册两个离线测试模型。父模型固定发起工具调用，输入 `deny` 时改为请求一个未声明的目标。子模型返回固定文本。

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

## 3. 运行并查询 Trace

另开终端执行下方脚本。默认请求 `http://127.0.0.1:8080`，可通过 `AGENT_TEST_URL` 覆盖。按业务工程的鉴权方式配置请求。

- 使用框架的 `s_t` / `s_sign` 验签时，通过 `AGENT_TEST_SIGN_KEY` 注入当前测试环境的签名密钥。脚本会为每次请求生成签名。
- 需要业务登录时，先按该工程的登录流程获取测试凭据，再通过 `AGENT_TEST_HEADERS` 传入 JSON 请求头，例如 `{"Cookie":"<测试会话 Cookie>"}`。如果项目要求按请求生成其他鉴权头，可在 `request()` 中接入项目的签名逻辑。

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

要验证预算拒绝，在启动选项的 `ai` 中增加 `runtime: { delegation: { maxChildRuns: 0 } }`，重启后单独请求父 Agent。固定测试模型仍会发起调用，父步骤应出现 `DELEGATE_BUDGET_EXCEEDED`，且没有 `childRunId`。改用 `maxDepth: 0` 可验证 `DELEGATE_DEPTH_EXCEEDED`。改用 `maxModelCalls: 1` 可验证根调用用尽模型预算后无法创建子运行。
