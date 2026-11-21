# Agent 运维能力接入

以下接口均走现有 AI 验签或业务登录授权，完整协议见 [OpenAPI](openapi.json)。

| 方法和路径（均以 `/api/ai` 开头） | 用法 |
| --- | --- |
| `POST /agent/runs` | 传 `{ agent, input, threadId? }`，收到 202 后保存 `data.runId` |
| `GET /agent/runs?limit=20&offset=0` | 查询当前 scope 可访问的运行摘要 |
| `GET /agent/runs/:runId` | 查询状态、步骤、答案、用量、审批要求和失败原因 |
| `GET /agent/runs/:runId/events?after=0` | SSE 重放已持久化的步骤，再追踪进度。重连时将最后收到的 `sequence` 作为 `after` |
| `POST /agent/runs/:runId/cancel` | 取消排队、运行或待审批的任务 |
| `POST /agent/runs/:runId/approval` | 传 `{ approvalId, approved }`；授权需包含 `approve: true` |
| `GET /rag/documents` | 列出配置目录在索引中的文档和切片数 |
| `DELETE /rag/documents` | 传 `{ docId }`，删除该文档的索引切片，保留源文件 |
| `POST /rag/rebuild` | 按当前切分和向量化配置重建；读取或向量化失败的文档保留原索引 |
| `POST /rag/preview` | 传 `{ query, topK? }`，预览检索命中和引用标记 |
| `GET /rag/chunk?id=...` | 传 URL 编码的 `citations[].chunkId`，定位当前索引的来源切片 |

异步 SSE 提供 `start`、带序号的 `step`、状态变化的 `status` 和终态 `done`。它回放结构化进度；需要逐字输出请继续使用 `POST /agent/run/stream`。同步和旧流式接口的结果保留 `runId`、`output`、`steps`、`threadId`。待审批时返回 `status: "waiting_approval"` 和 `approval`；提交决定后使用运行详情或异步 SSE 获取最终结果。

运行状态为 `queued`、`running`、`waiting_approval`、`succeeded`、`failed`、`cancelled` 或 `interrupted`。摘要的 `modelDurationMs` 是本运行各次规划调用耗时之和；子运行单独计量。供应商未报告用量时，不填入估算值。无法访问的运行和不存在的运行均返回 404。

知识库是进程配置的共享资源。管理读取需授权 `ragRead: true` 或 `ingest: true`，修改需 `ingest: true`。Agent 的系统提示可要求在用到来源时原样复制检索返回的 `[cite:…]` 标记；只有正文引用并实际检索到的切片才进入 `citations`。历史 Trace 的检索步骤可用于回看当时的文本；重建后的在线查找展示当前索引，可比较引用标记辨认是否换版。删除索引后，源文件仍在配置目录中时会被下次重建重新索引。

在业务工程的 Skill 或 Tool 定义中设置 `approval: 'required'`。内置 `service-invoke` 可用 `ai.tools.serviceInvokeApproval: true` 启用审批；MCP 通过每个 server 的 `approvalTools: ['tool-name']` 配置。审批 ID 只对应记录里的一个待批调用；重复决定返回 409。拒绝会给模型一个失败观察并继续执行。外部写操作可以使用 Skill/Tool 上下文中的 `idempotencyKey` 保证下游幂等。

委派配置、预算规则及离线验证见 [Agent 委派接入示例](agent-delegation.md)。

文件存储和后台队列供单写进程部署。后台最多同时处理四个任务，已排队和执行中的后台任务合计达到 100 时，提交或审批会返回 429，可稍后重试。重启后可以继续待审批的运行；排队或执行中的运行在下次查询时标记为中断。取消会传给支持 `AbortSignal` 的模型和能力，不能撤销已发生的外部操作。自定义 TraceStore 需实现 `list` 才能支持运行列表；自定义 VectorStore 需实现 `documents`、`removeDocument`、`loadChunk`，并在 `query` 中兑现 root 过滤，才能使用新增管理接口。

## CI 离线评测

将 [示例用例集](../sdd/agent-operations/eval-suite.example.json) 复制到业务工程的 `eval/cases.json`，调整 Agent、工具名、知识库文档 ID 和断言。CLI 顺序请求测试服务的 `POST /api/ai/agent/run`。如需在无外部网络的环境运行，在测试服务中配置本地模型和 Embedding。

在测试服务配置文件中注册 CI 签名凭据。以下配置允许 `agent-eval` 运行 `support`，对已注册的 `admin` 返回 HTTP 403。启用 `threadEnabled` 后，Agent 可以读取同一用例前几轮的对话。

```js
module.exports = {
  agentConfig: { threadEnabled: true },
  ai: {
    access: {
      keys: {
        'agent-eval': {
          secret: process.env.AGENT_EVAL_SECRET,
          scope: 'agent-eval-ci',
          agents: ['support'],
        },
      },
    },
  },
};
```

通过 CI 的密钥变量提供 `AGENT_EVAL_SECRET`，并将 `AGENT_EVAL_KEY_ID` 设为 `agent-eval`。CLI 为每个请求生成新 nonce。框架的 `serverStart()` 已启用原始请求体读取。直接使用 `NestFactory.create()` 启动时传入 `{ rawBody: true }`，供签名校验使用。

```sh
npx flico-agent-eval --suite ./eval/cases.json --url http://localhost:8080 --out ./eval-report.json
```

从源码运行时，先执行 `npm run build`，再使用 `npm run eval --` 传入相同参数。省略 `--out` 时 JSON 写入标准输出。用 `--timeout-ms` 设置单次请求超时，默认 60000 毫秒。

| 用例字段 | 行为 |
| --- | --- |
| `cases[].id`、`agent`、`turns` | 唯一用例 ID、Agent 名称、按顺序执行的轮次。每个用例生成独立线程，同一用例的轮次复用该线程。 |
| `turns[].input` | 发送给 Agent 的 JSON 值。 |
| `turns[].expectStatus` | 指定 HTTP 状态码，默认为任意 2xx。用 `403` 验证调用者权限。 |
| `assert.toolsUsed` | 列出的能力必须全部出现在执行成功的 `tool` 或 `skill` 步骤中，按完整名称匹配。 |
| `assert.citationDocIds` | 列出的文档 ID 必须全部出现在结构化 `citations` 中。知识库需要预先灌入，Agent 的答案需原样复制 `retrieve` 返回的引用标记。 |
| `assert.outputNotEmpty`、`assert.outputContains` | 用 `true` 检查非空输出，用字符串检查记忆内容。`outputContains` 和 `outputContainsAny` 接收数组时命中任一项即可。 |
| `assert.guardrailBlocked` | 布尔值，检查是否存在 `guardrail` 步骤。也可使用 `blocked`。 |
| `assert.stepsContain` | 字符串或数组，检查步骤中是否包含任一指定名称。 |

报告包含总用例数、通过数、失败数、耗时，以及各轮的 HTTP 状态、运行 ID 和断言失败项。报告省略输入、模型输出和签名凭据。某轮失败后会继续执行剩余轮次和用例。待审批响应会计为评测失败。

| 退出码 | 含义 |
| --- | --- |
| `0` | 所有用例通过，或成功显示帮助。 |
| `10` | 至少一个用例失败，包括请求超时、状态不符或断言失败。 |
| `20` | CLI 参数、签名环境变量或用例文件有误。 |
| `30` | 无法将 JSON 报告写入指定文件或标准输出。 |

业务代码可以从 `@flicoh/agent/eval` 导入 `parseSuite` 和 `runSuite`，并向 `runSuite` 提供接收 `{ agent, input, threadId }`、返回 `{ status, body }` 的异步请求函数。
