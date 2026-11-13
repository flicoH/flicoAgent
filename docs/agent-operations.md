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

Agent 声明 `delegates: ['research-agent']` 后，模型可调用 `agent-delegate`，参数为 `{ agent, input }`。目标还必须在调用者的 Agent 白名单内（如有配置）。每个根运行最多发起四个子运行，最多两层委派，共享模型调用预算为 `ai.runtime.maxIterations + 10`。子 Agent 不获得父会话历史，且不会在子运行里执行审批工具。用父步骤的 `childRunId` 和子详情的 `parentRunId` / `rootRunId` 回看调用链。

文件存储和后台队列供单写进程部署。后台最多同时处理四个任务，已排队和执行中的后台任务合计达到 100 时，提交或审批会返回 429，可稍后重试。重启后可以继续待审批的运行；排队或执行中的运行在下次查询时标记为中断。取消会传给支持 `AbortSignal` 的模型和能力，不能撤销已发生的外部操作。自定义 TraceStore 需实现 `list` 才能支持运行列表；自定义 VectorStore 需实现 `documents`、`removeDocument`、`loadChunk`，并在 `query` 中兑现 root 过滤，才能使用新增管理接口。

## CI 离线评测

把用例放在业务工程，使用隔离的服务环境和测试签名凭据。启用 `agentConfig.threadEnabled` 后，多轮用例可以检验真实会话记忆。示例见 [用例集](../sdd/agent-operations/eval-suite.example.json)。

```sh
npx flico-agent-eval --suite ./eval/cases.json --url http://localhost:9002 --out ./eval-report.json
```

CI 注入 `AGENT_EVAL_KEY_ID` 与 `AGENT_EVAL_SECRET`。运行时每个请求生成新 nonce。退出码：0 全部通过、1 至少一个用例失败、2 参数、用例文件或报告写入失败。用例中的 `toolsUsed` 只认真实执行成功的步骤，`citationDocIds` 检查结构化引用，`expectStatus` 可验证授权返回 403。评测沿用同步 Agent 接口；需要审批的配置会报告该运行未结束。
