# Agent 运维能力接入

中文 | [English](agent-operations.en.md)

以下接口均走现有 AI 验签或业务登录授权，完整协议见 [OpenAPI](openapi.json)。

| 方法和路径（均以 `/api/ai` 开头） | 用法 |
| --- | --- |
| `POST /agent/runs` | 传 `{ agent, input, threadId? }`，收到 202 后保存 `data.runId` |
| `GET /agent/runs?limit=20&offset=0` | 查询当前 scope 可访问的运行摘要 |
| `GET /agent/runs/:runId` | 查询状态、步骤、答案、用量、审批要求和失败原因 |
| `GET /agent/runs/:runId/events?after=0` | SSE 重放已持久化的步骤，再追踪进度。重连时将最后收到的 `sequence` 作为 `after` |
| `POST /agent/runs/:runId/cancel` | 取消排队、运行或待审批的任务 |
| `POST /agent/runs/:runId/approval` | 传 `{ approvalId, approved }`；授权需包含 `approve: true` |
| `GET /rag/documents` | 列出当前知识来源已索引的文档和切片数 |
| `DELETE /rag/documents` | 传 `{ docId }` 删除索引切片，保留原文 |
| `POST /rag/rebuild` | 按当前来源、切分和向量化配置重建索引 |
| `POST /rag/preview` | 传 `{ query, topK? }`，预览检索命中和引用标记 |
| `GET /rag/chunk?id=...` | 传 URL 编码的 `citations[].chunkId`，定位当前索引的来源切片 |
| `GET /rag/wiki/pages` | 列出已发布的 Wiki 主题页、标题和章节数 |
| `GET /rag/wiki/page?id=...` | 读取主题页 Markdown、相关页面和各章节的原文依据 |

异步 SSE 提供 `start`、带序号的 `step`、状态变化的 `status` 和终态 `done`。它回放结构化进度；需要逐字输出请继续使用 `POST /agent/run/stream`。同步和旧流式接口的结果保留 `runId`、`output`、`steps`、`threadId`。待审批时返回 `status: "waiting_approval"` 和 `approval`；提交决定后使用运行详情或异步 SSE 获取最终结果。

运行状态为 `queued`、`running`、`waiting_approval`、`succeeded`、`failed`、`cancelled` 或 `interrupted`。摘要的 `modelDurationMs` 是本运行各次规划调用耗时之和；子运行单独计量。供应商未报告用量时，不填入估算值。无法访问的运行和不存在的运行均返回 404。

在业务工程的 Skill 或 Tool 定义中设置 `approval: 'required'`。内置 `service-invoke` 可用 `ai.tools.serviceInvokeApproval: true` 启用审批；MCP 通过每个 server 的 `approvalTools: ['tool-name']` 配置。审批 ID 只对应记录里的一个待批调用；重复决定返回 409。拒绝会给模型一个失败观察并继续执行。外部写操作可以使用 Skill/Tool 上下文中的 `idempotencyKey` 保证下游幂等。

委派配置、预算规则及离线验证见 [Agent 委派接入示例](agent-delegation.md)。

文件存储和后台队列供单写进程部署。后台最多同时处理四个任务，已排队和执行中的后台任务合计达到 100 时，提交或审批会返回 429，可稍后重试。重启后可以继续待审批的运行；排队或执行中的运行在下次查询时标记为中断。取消会传给支持 `AbortSignal` 的模型和能力，不能撤销已发生的外部操作。自定义 TraceStore 需实现 `list` 才能支持运行列表。

## RAG 知识库

配置 `ai.embedding`、原文来源和向量索引后，调用 `POST /api/ai/rag/rebuild` 建立索引。原文和索引分别配置。Agent 启用内置 `retrieve` 后，检索和预览使用同一个已配置的索引。

| 配置 | 可用值 | 行为 |
| --- | --- | --- |
| `ai.rag.source.driver` | `file`（默认）、`mysql` | 从 UTF-8 的 Markdown、TXT、JSON 文件或 MySQL 原文表建立索引。文件目录依次读取 `ai.store.vector.fixturesPath`、`ai.rag.fixtures.path`，默认 `data/fixtures`。 |
| `ai.store.vector.driver` | `file`（默认）、`mysql`、`qdrant` | 决定切片、向量和定位元数据的存储位置。MySQL 将向量存为 JSON，应用执行余弦排序。Qdrant 在向量库内执行相似度检索。 |

### MySQL 与 Qdrant 配置

下面的组合在 MySQL 保管原文，由 Qdrant 提供向量检索。MySQL 连接复用框架的 `db` 配置。对 MySQL 8 数据库执行 [建表脚本](rag-mysql.sql)，再将文档写入 `flico_rag_documents` 的指定 `collection`。`doc_id` 是集合内稳定的文档 ID，`body` 是原文。已有文件可继续作为来源，按相同接口重建到数据库索引。

```js
module.exports = {
  db: {
    client: 'mysql2',
    connection: {
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    },
  },
  ai: {
    rag: { source: { driver: 'mysql', collection: 'support' } },
    store: {
      vector: {
        driver: 'qdrant',
        namespace: 'support-prod',
        url: process.env.QDRANT_URL,
        apiKey: process.env.QDRANT_API_KEY,
        dimensions: 1536,
      },
    },
  },
};
```

```sql
INSERT INTO flico_rag_documents (collection, doc_id, body)
VALUES ('support', 'policy/refunds.md', '退款申请须在三十天内提出。');
```

向量维度必须与 `ai.embedding` 配置的模型一致。Qdrant 会为每个来源创建一个索引别名，重建通过切换别名发布新索引。应用连接需要创建集合、更新别名和读写向量点的权限。Qdrant 同一命名空间由一个应用进程执行删除和重建，其他实例可以读取。共享数据库的项目与环境使用各自的 `namespace`，选择相同命名空间和来源即可复用已有索引。[Qdrant 别名接口](https://api.qdrant.tech/api-reference/aliases/update-aliases)

要把向量索引也存进 MySQL，将 `ai.store.vector` 设为 `{ driver: 'mysql', namespace: 'support-prod' }`。MySQL 通过事务发布重建并协调同命名空间的索引写入。向量索引写入权限可单独授予，读取原文只需源表的 `SELECT` 权限。

### LLM Wiki 和混合检索

设置 `ai.rag.mode` 后调用 `POST /api/ai/rag/rebuild`。预览和内置 `retrieve` 共享此模式与索引。

| 模式 | 检索内容 |
| --- | --- |
| `rag`（默认） | 原文切片。此模式的重建发布原文索引。 |
| `wiki` | LLM 编译并持久化的 Markdown 主题章节。原文切片仍可通过章节的来源 ID 定位。 |
| `hybrid` | 对同一索引快照分别检索原文和 Wiki，按倒数排名融合合并到同一个 TopK。此模式的 `score` 是融合分数。 |

例如将 `ai.rag` 设为 `{ mode: 'hybrid', wiki: { model: 'knowledge-editor' } }`，其中 `knowledge-editor` 是已有的 `ai.llm.models` 配置键。省略 `wiki.model` 时使用 `ai.llm.default`。从原文索引升级时，切换模式后运行一次重建。MySQL 沿用现有表，Qdrant 重建会为新集合添加 Wiki 检索字段索引。

Wiki 编译把原文切片分批交给模型。模型按主题生成带来源的章节，并在页面目录已有对应主题时沿用页面 ID。不同文档的章节可汇入同一主题页。原文未变的章节在下一次重建时复用。返回的 `wiki.pages` 和 `wiki.sections` 是发布后的总数，`wiki.generatedSections` 是本次新生成的章节数。`chunks` 继续统计本次写入的原文切片。

发布前校验章节引用是否属于其编译批次，并筛除不存在的内部页面链接。原文与 Wiki 作为一代索引一起发布。模型编译失败、返回无效引用或 Wiki 向量化失败时，整次重建保留旧索引。单份原文读取或向量化失败时，保留该文档及其上次 Wiki 章节。删除源索引会同步移除该文档生成的章节，主题页仍可展示其他文档留下的章节。源文档依旧存在时，下次重建会重新收录。

Wiki 章节命中带有 `meta.kind: 'wiki'` 和 `meta.wiki`。正文实际引用该命中时，`citations` 会带上 `kind: 'wiki'` 和 `pageId`。按其 `chunkId` 定位时，`meta.wiki.sources` 附带原文切片 ID、版本、原文文本及可用的字符范围。历史 Trace 保存检索当时的这些原文片段，换版后仍可回看。

### 管理和引用

管理接口使用 `ai.access.keys` 的服务间签名或 `ai.access.authorize` 返回的会话授权。列表、预览、切片定位和 Wiki 页面读取需要 `ragRead: true` 或 `ingest: true`。删除和重建需要 `ingest: true`。将检索工具提供给哪些 Agent 由各 Agent 的工具声明控制。

- **重建**按配置来源同步索引。成功处理的文档替换旧切片，已移除和无有效切片的文档从索引清理。读取或向量化失败的文档保留上次结果。响应的 `ingested` 是扫描到的文档数，`chunks` 是本次写入的切片数，`succeeded`、`skipped` 和 `failed` 给出逐文档结果。来源查询失败时保留旧索引。本地源目录缺失返回 404。成功读取空来源会清空该来源的索引。
- **删除**按 `docId` 移除索引切片并返回 `removed` 计数。原文保留，下次重建会重新收录。文档不存在于索引时返回 404。
- **预览和定位**预览传 `{ "query": "退款规则", "topK": 3 }`，可从 `hits[]` 复制 `id` 到 `GET /api/ai/rag/chunk?id=…`。查询参数需要 URL 编码。定位返回切片正文、引用标记与 `meta.version`。文件可通过 `meta.relativePath` 定位，MySQL 可通过 `meta.collection` 和 `docId` 定位。默认切分器提供准确的 `meta.start` 和 `meta.end`，采用左闭右开的 UTF-16 下标，可以直接用 `source.slice(start, end)` 定位。旧索引或提供自定义切片文本的切分器可能缺少版本或准确位置。检索分数只出现在检索响应中。
- **答案引用**Agent 在使用证据的正文陈述旁插入检索结果的 `[cite:…]` 标记。服务端按正文首次出现顺序收录本轮成功检索中对应的切片。代码块、行内代码、转义示例及仅留在草稿中的标记都不计入。同一份 `citations` 写入 Agent 响应、SSE 的 `done` 和 Trace。没有有效引用时省略该字段。
- **历史引用**在线定位返回当前索引。切片所属文档换版或删除后，旧 ID 返回 404。仍有 Trace 访问权限时，通过 `GET /api/ai/trace/:runId` 在当时的 `retrieve` 步骤中按 `chunkId` 查找原文。

三个内置后端在重建准备期间都继续提供旧索引。默认文件索引面向单写进程，发布时原子替换磁盘索引。旧文件索引中有来源路径的切片可继续查询和定位，下次重建会替换为带版本的切片。可通过 `ai.store.vector.use` 接入其他 `VectorStore` 实例或工厂。自定义后端需实现 `syncDirectory`、`documents`、`removeDocument` 和 `loadChunk` 来支持管理接口。接入 Wiki 时还需实现 `wikiChunks`，在选取 TopK 前按来源和类型过滤，并在删除源索引时移除对应的 Wiki 章节。`queryHybrid` 可在同一个快照返回两路排名。

本地无外部模型的回归测试使用测试自带的 Embedding 和 LLM。

```sh
npm run build
__ENV=local ./node_modules/.bin/mocha test/ai/rag.test.js
__ENV=local ./node_modules/.bin/mocha test/ai/rag-wiki.test.js
__ENV=local ./node_modules/.bin/mocha test/ai/api-hardening.test.js --grep 'RAG 管理接口|Wiki 管理'
```

数据库集成测试使用独立 MySQL 测试库和 Qdrant 测试实例。设置 `RAG_MYSQL_TEST_URL` 运行 MySQL 用例，设置 `RAG_QDRANT_TEST_URL` 及需要时的 `RAG_QDRANT_TEST_KEY` 运行 Qdrant 用例。两组配置同时存在时也会运行组合用例。

```sh
__ENV=local ./node_modules/.bin/mocha test/ai/rag-database.test.js
```

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

## 多实例生产存储与分布式防重放

默认文件存储（`FileTraceStore`、`FileMemoryStore`）与内存 Nonce 表（`InMemoryNonceStore`）适用于单实例部署。多副本水平扩展时，可切换为内置的 **MySQL** 或 **Redis** 驱动，或通过 `use` 注入自定义实例/工厂：

| 配置项 | 可选 `driver` | 能力说明 |
| --- | --- | --- |
| `ai.store.trace` | `file`（默认）、`mysql`、`redis` | 持久化运行状态、步骤、用量、审批快照，并支持按 `scope` 与 `agents` 分页列表 |
| `ai.store.memory` | `file`（默认）、`mysql`、`redis` | 持久化多轮对话检查点；`mysql` 使用 `GET_LOCK`、`redis` 使用 `SET NX PX` + Lua 解锁实现跨实例 `runTurn` 串行锁 |
| `ai.access.nonceStore` | `memory`（默认）、`mysql`、`redis` | 原子消费 HMAC 请求 `x-agent-nonce`，跨实例防止签名重放 |

### MySQL 多实例配置

对 MySQL 数据库执行 [建表脚本](p0-store-mysql.sql) 创建 `flico_ai_traces`、`flico_ai_memory` 和 `flico_ai_nonces` 三张表，并复用框架的 `db` 连接配置：

```js
module.exports = {
  db: {
    client: 'mysql2',
    connection: {
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    },
  },
  ai: {
    access: {
      nonceStore: { driver: 'mysql', namespace: 'prod' },
    },
    store: {
      trace: { driver: 'mysql', namespace: 'prod' },
      memory: { driver: 'mysql', namespace: 'prod', lockTimeoutSeconds: 30 },
    },
  },
};
```

### Redis 多实例配置

框架通过最小接口 `RedisLikeClient`（`get`、`set`、`del` 及可选 `eval`、`zadd`、`zrevrange`、`expire`）兼容 `ioredis` / `node-redis`，业务工程直接传入已创建的客户端实例即可，无需强绑框架依赖版本：

```js
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);

module.exports = {
  ai: {
    access: {
      nonceStore: { driver: 'redis', namespace: 'prod', client: redis },
    },
    store: {
      trace: { driver: 'redis', namespace: 'prod', ttlMs: 7 * 24 * 3600 * 1000, client: redis },
      memory: { driver: 'redis', namespace: 'prod', lockTtlMs: 60_000, lockTimeoutMs: 30_000, client: redis },
    },
  },
};
```

## 服务端口与优雅停机

- 监听端口按以下优先级解析：`serverStart({ port })` > 配置文件 `port` > 环境变量 `PORT` > 默认 `8080`；同时支持可选 `host`。
- `bootstrap()` 默认启用 Nest 优雅停机钩子（`enableShutdownHooks()`），收到 `SIGTERM`/`SIGINT` 时自动关闭 MCP 子进程并释放数据库连接池。如需自定义停机流程，可传入 `shutdownHooks: false`。
