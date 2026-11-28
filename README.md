# flicoAgent

中文 | [English](README.en.md)

flicoAgent 是一个基于 NestJS 的应用框架内核，提供项目配置、页面与静态资源服务、业务模块自动发现，以及可选的 LLM、Agent、Skill、MCP、RAG 和会话记忆能力。前端采用 Vue 3、Vite 与 Element Plus。

本仓库包含框架源码和示例页面。框架也支持被业务工程作为 npm 包依赖；业务工程需按下文约定提供配置、页面和模块构建产物。

## 功能概览

- NestJS HTTP 服务，默认监听 `8080`（支持 `port` / `PORT` 环境变量与优雅停机）
- 基于 `_ENV` 或 `__ENV` 加载环境配置
- 自动加载业务工程 `dist/modules/**/*.module.js`、`dist/skills/**/*.skill.js` 和 `dist/agents/**/*.agent.js`
- Vue 3 + Vite 多页面构建及 Nunjucks 页面模板
- 可配置的 OpenAI 兼容 LLM（支持推理参数、主备模型 Fallback 与熔断）、Agent 结构化输出（`outputSchema`）、Embedding、MCP 工具、RAG、Guardrail、Memory 与 Trace
- 内置文件型 Trace、Memory 和 Vector 存储实现
- `flico-agent-eval` 离线回归评测，提供 JSON 报告和 CI 退出码

## 从 GitHub 克隆并运行

需要 Node.js 22.22.3（仓库的 `.nvmrc` 指定版本）和 npm 10。

```bash
git clone --branch feature/agent https://github.com/flicoH/flicoAgent agent
cd agent
nvm install  # 使用 nvm 时执行，读取 .nvmrc
nvm use      # 已使用指定 Node.js 版本时可跳过两条 nvm 命令
npm ci
npm run build
node -e "require('./index').frontendBuild('production')"
node -e "require('./index').serverStart()"
```

`npm run build` 将后端编译到 `dist/`。前端构建生成 `app/public/dist/entry.dashboard.tpl` 和 `app/public/dist/prod/` 下的静态资源。这些文件需要在克隆后本地生成。

打开 [示例 Dashboard](http://localhost:8080/view/dashboard)，或在另一个终端执行：

```bash
curl --fail --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  http://localhost:8080/view/dashboard
```

返回 `200` 表示 Nest 已成功渲染页面模板。此检查无需数据库或模型密钥。Dashboard 的业务数据和功能仍依赖项目配置、业务数据及 API 验签。

### 前端开发模式

先执行 `npm run build`，再从仓库根目录分别在两个终端运行：

```bash
# 终端 1：Vite 开发服务，生成引用开发资源的模板
node -e "require('./index').frontendBuild('local')"

# 终端 2：Nest 服务
node -e "require('./index').serverStart()"
```

仍通过 `http://localhost:8080/view/dashboard` 打开页面，Vite 从 `http://127.0.0.1:9002` 提供开发资源。结束开发后，重新执行生产前端构建即可生成引用生产资源的模板。

## 作为业务工程依赖

如果此版本已发布到 npm，在业务工程中安装：

```bash
npm install @flicoh/agent
```

准备业务目录结构。框架在业务工程的 `process.cwd()` 下查找配置、静态页面、构建产物及数据目录：

```text
business-app/
├── config/
│   ├── config.default.js
│   ├── config.local.js       # 本地密钥；不要提交
│   ├── config.beta.js        # 可选
│   └── config.prod.js        # 可选
├── app/
│   ├── public/               # 页面模板与静态文件
│   └── pages/                # 业务 Vue/Vite 页面（可选）
├── src/
│   ├── modules/              # 业务 Nest 模块（可选）
│   ├── skills/               # Skill 定义（可选）
│   └── agents/               # Agent 定义（可选）
└── dist/                     # 业务代码的编译产物
    ├── modules/**/*.module.js
    ├── skills/**/*.skill.js
    └── agents/**/*.agent.js
```

从业务工程根目录启动。如果工程有 TypeScript 业务模块、Skill 或 Agent，先将其编译到上述 `dist/` 路径：

```bash
node -e "require('@flicoh/agent').serverStart()"
```

框架会扫描 `dist/modules/` 中的 Nest 模块，并扫描 Skill 与 Agent 定义；未提供这些目录时对应扩展能力为空。业务 Nest 模块需导出带有 Nest 模块元数据的模块类；Skill 和 Agent 文件需按其定义接口使用 `default export` 导出。Agent 可引用相对其编译后文件位置的 Prompt 模块。

若业务工程要构建前端资源，且其 Vite 配置可以使用本包提供的配置：

```bash
node -e "require('@flicoh/agent').frontendBuild('local')"       # 开发服务器
node -e "require('@flicoh/agent').frontendBuild('production')"  # 生产构建
```

## 配置

复制或创建 `config/config.default.js`。框架默认配置位于包内 `config/config.default.js`；业务工程可在自己的 `config/` 中覆盖。配置加载优先级由低到高为：框架默认配置、业务 `config.default.js`、当前环境配置、`serverStart(options)` 启动参数。`ai` 与 `agentConfig` 对象支持深度合并，其他顶层项按后层覆盖。TypeScript 工程可从 `@flicoh/agent` 或 `@flicoh/agent/nest` 导入 `BootstrapOptions`、`AiOptions`、`RagOptions`、`RagMode`、`VectorStore`、`ConfigService` 等配置与扩展契约。

环境选择：

| 环境变量 | 读取的业务配置 | 默认值 |
| --- | --- | --- |
| `_ENV` | `local` → `config.local.js`，`beta` → `config.beta.js`，`production` → `config.prod.js` | `local` |
| `__ENV` | 同上，仅在 `_ENV` 未设置时生效 | `local` |

环境配置文件位于运行目录的 `config/` 下，文件缺失时跳过该层。仓库里的 `config.bate.js` 为旧文件名，预发覆盖需使用 `config.beta.js`。

示例 `config/config.default.js`：

```js
module.exports = {
  name: 'my-business-app',
  // 可选：页面路由等业务配置
  apiSignVerify: {
    // 仅列出确认允许免验签的 API 路径
    whiteList: [],
  },
};
```

示例 `config/config.local.js`（不要把真实密钥提交到 Git）：

```js
module.exports = {
  ai: {
    llm: {
      default: 'qwen',
      models: {
        qwen: {
          provider: 'openai-compatible',
          baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          model: 'qwen-plus',
          apiKey: process.env.DASHSCOPE_API_KEY,
        },
      },
    },
    embedding: {
      default: 'qwen-embedding',
      models: {
        'qwen-embedding': {
          provider: 'dashscope-compatible',
          baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          model: 'text-embedding-v3',
          apiKey: process.env.DASHSCOPE_API_KEY,
        },
      },
    },
    // 使用相对业务工程根目录的可写数据目录
    store: {
      trace: 'data/trace',
      memory: 'data/memory',
      vector: 'data/vector.json',
    },
  },
};
```

LLM/Embedding 密钥仅在实际调用相应能力时必需。Embedding provider 支持 `dashscope-compatible` 和 `openai-compatible`；LLM 内置 provider 为 `openai-compatible`，并支持在全局 `ai.llm`、单模型及 `AgentDefinition` 三层配置 `temperature`、`maxTokens`、`topP`、`timeoutMs`、`fallbacks` 与 `circuitBreaker`（详见 [LLM 推理参数、主备 Fallback 与熔断](docs/agent-operations.md#llm-推理参数主备-fallback-与熔断)）。`ai.mcp` 默认关闭；如需使用 MCP，请配置服务器并启用。业务配置还可通过 `require('@flicoh/agent').serverStart({ name: 'my-app' })` 传入启动选项。

## 页面与接口

- Nest HTTP 服务监听 `8080`。
- 页面控制器通过 `/view/:page` 查找业务工程 `app/public/dist/entry.:page.tpl` 模板。
- 静态资源从业务工程 `app/public/` 提供。
- 内置项目 API 路径包括 `/api/project`、`/api/project/list` 和 `/api/project/model_list`。
- 项目及业务 API 沿用 `s_sign` 与 `s_t`。`apiSignVerify.whiteList` 可配置业务 API 免签路径。
- AI API 使用独立授权，接口契约见 [OpenAPI](docs/openapi.json)。运行管理、知识库、审批、委派和 CI 接入见 [Agent 运维能力接入](docs/agent-operations.md)。

页面模板和业务路由的具体数据依赖业务工程配置及产物；单独克隆本框架不会自带业务项目数据或数据库内容。

### 接入 AI API

浏览器继续使用现有签名头。业务工程配置 `ai.access.authorize(request)`，由回调验证真实登录会话，并返回 `{ scope, agents?, skills?, ragRead?, ingest? }`。`scope` 由服务端生成，用于隔离会话与 Trace。可用 `agents` 限制可运行的 Agent，用 `skills` 限制可直调的 Skill。回调返回 `null` 时请求被拒绝。

服务间调用在服务端配置 `ai.access.keys.<keyId>`，值为 `{ secret, scope?, agents?, skills?, ragRead?, ingest? }`。客户端发送以下请求头。

| 请求头 | 值 |
| --- | --- |
| `x-agent-key-id` | 调用方 key ID |
| `x-agent-nonce` | 每个请求唯一的随机值，例如 UUID |
| `s_t` | 13 位 Unix 毫秒时间戳 |
| `s_sign` | 下述消息的 HMAC-SHA256 十六进制值 |

待签名消息由 key ID、大写 HTTP 方法、请求路径及原始查询串、`s_t`、nonce、原始请求体的 SHA-256 十六进制值依次以换行连接。空正文按空字节串计算摘要。签名允许 5 分钟时钟偏差，nonce 在单个进程内防重放。多实例部署可在网关统一校验 nonce。

历史 HTTP 会话和 Trace 缺少授权归属，需要由业务按明确的归属迁移。Trace 存储记录增加 `scope`。会话存储键为 `scope-` 加 `JSON.stringify([scope, threadId])` 的 SHA-256 十六进制值。

### SSE 和存储

- Agent 流发送 `start`、`step`、`delta`，成功时以 `done` 收尾。收到 `delta_reset` 时清空当前回答的临时文本，继续保留步骤。Chat 流发送 `delta` 与 `done`（主备切备中途失败时同样发送 `delta_reset`）。响应开始后的失败以 `error` 事件返回，连接空闲时会发送心跳。
- Skill 与 Tool 的 `inputSchema` 在执行前校验。`ai.tools.serviceInvoke` 以服务名为键，以开放的方法名数组为值。例如 `{ ProjectService: ['getProjectDetail'] }`。
- `ai.store.trace`、`ai.store.memory` 支持 `file`（默认）、`mysql`、`redis` 驱动或 `use` 工厂，`ai.store.vector` 支持 `file`、`mysql`、`qdrant` 或 `use` 工厂；`ai.access.nonceStore` 支持 `memory`（默认）、`mysql`、`redis` 跨实例防重放。详细接入见 [多实例生产存储与分布式防重放](docs/agent-operations.md#多实例生产存储与分布式防重放)。
- 知识库提供文档列表、删除索引、重建、检索预览、Wiki 主题页读取和切片定位。原文可来自文件目录或 MySQL，向量索引支持文件、MySQL 和 Qdrant。检索支持原文 RAG、LLM Wiki 和混合模式（`ai.rag.mode`）。连接配置和引用定位见 [RAG 知识库](docs/agent-operations.md#rag-知识库)。

## npm 脚本

| 命令 | 说明 |
| --- | --- |
| `npm run build` | 编译 Nest/TypeScript 代码至 `dist/` |
| `npm run build:watch` | 监听模式编译 |
| `npm run eval -- --help` | 查看离线评测命令（先执行 `npm run build`） |
| `npm test` | 运行 Mocha 测试（测试脚本使用 `__ENV=local`） |
| `npm run lint` | 对 JS/Vue 文件执行 ESLint |

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `app/main.ts`、`app/app.module.ts` | Nest 启动与模块装配 |
| `app/modules/` | 内置项目、页面与回退路由模块 |
| `app/ai/` | AI Runtime、LLM、Embedding、RAG、MCP、Skill、Agent 与存储接口 |
| `app/pages/` | 框架 Vue 页面与组件 |
| `app/public/` | 框架公共资源及模板 |
| `app/vite/` | Vite 多页面构建配置 |
| `config/` | 框架默认配置及环境配置 |
| `model/` | 模型入口 |
| `test/` | Nest 和 AI 单元/集成测试 |
| |

### Token 用量

Agent 同步结果、SSE 的 `done` 和 Trace 记录均可返回 `usage`，包含 `inputTokens`、`outputTokens`、`totalTokens`。每轮模型调用只记录一次，即使该轮请求多个工具。Trace 的规划步骤可查看单轮用量，`usage: null` 表示该轮未上报。自定义 Provider 可通过 `LlmChatResult.usage` 上报用量。

用 `GET /api/ai/trace/{runId}/usage` 查询单次运行的消耗，返回 `{ success: true, data: { runId, usage } }`。合计只包含模型实际报告的用量。没有已上报数据时，查询接口返回 `usage: null`，包括加入统计之前的运行。

### Agent 循环模式

在业务工程的 `app/agents/*.agent.ts` 中通过 `AgentDefinition.mode` 选择运行模式。省略 `mode` 时默认使用 `react`。

```ts
import type { AgentDefinition } from '@flicoh/agent';

export default {
  name: 'report-reviewer',
  mode: 'reflection',
  maxReflectionRevisions: 1,
  skills: [],
  tools: [],
} satisfies AgentDefinition;
```

| `mode` | 执行流程 |
| --- | --- |
| `react` | 逐轮选择工具、观察结果，直到模型给出最终答案 |
| `plan-and-execute` | 生成有序的 JSON 步骤列表。依次执行每一步，最后汇总步骤结果 |
| `reflection` | 先生成草稿，再审阅。需要修改时按反馈修订，然后重新审阅 |

`maxReflectionRevisions` 默认是 `1`，设为 `0` 时只审阅一次。若审阅未通过且已达到修订上限，返回最后一份草稿，审阅步骤记录 `REFLECTION_LIMIT`。Plan-and-Execute 在本次运行中按初次生成的步骤执行。独立的规划、审阅和汇总阶段没有工具执行权限。

所有模型阶段均计入 `ai.runtime.maxIterations`，有委派时还计入运行树共享模型预算。Reflection 若要完成一次修订并再次审阅，至少需要四次模型调用，工具调用可能增加所需轮次。子 Agent 使用自己的 `mode`。同步和 SSE 接口仍按 Agent 名称发起运行，可以使用 `GET /api/ai/agent/graph?mode=reflection` 查看指定模式的拓扑。

### 结构化输出（`outputSchema`）

在 `AgentDefinition` 中声明 `outputSchema`（JSON Schema）与可选 `maxOutputRetries`（默认 `2`）后，框架会在提示词中自动注入结构约束、使用 `ajv` 严格校验最终输出 JSON，并在格式不合法时自动触发有限次纠错重试。校验通过后，同步接口、SSE `done` 与 Trace 会同时返回规范化的 JSON 字符串 `output` 与可直接消费的 `structuredOutput`；超出重试上限时在终态步骤记录 `INVALID_STRUCTURED_OUTPUT`。完整示例见 [Agent 结构化输出](docs/agent-operations.md#agent-结构化输出outputschema)。

### 多 Agent 委派

在 Agent 声明中设置 `delegates` 后，可以通过保留工具 `agent-delegate` 调用列出的子 Agent。父执行步骤提供 `childRunId`，子 Trace 提供 `parentRunId`、`rootRunId` 和 `delegationDepth`。配置及离线测试步骤见 [Agent 委派接入示例](docs/agent-delegation.md)。

### 离线评测

在业务工程安装包含该命令的 `@flicoh/agent` 版本，启动测试服务，并通过环境变量提供 `AGENT_EVAL_KEY_ID` 和 `AGENT_EVAL_SECRET`。

```sh
npx flico-agent-eval --suite ./eval/cases.json --url http://localhost:8080 --out ./eval-report.json
```

CLI 按顺序调用 Agent 同步接口，验证工具执行、RAG 引用、权限拦截和多轮记忆。CI 可根据退出码判断结果。服务端配置、用例和报告字段见 [CI 离线评测](docs/agent-operations.md#ci-离线评测)。

## 故障排查

- **提示缺少模型 API Key**：确认当前环境配置文件存在、环境名正确，并且 `apiKey` 已读取到有效环境变量。
- **业务模块或 Skill/Agent 未加载**：确认在业务工程根目录启动，并确认构建产物位于 `dist/modules/`、`dist/skills/`、`dist/agents/` 对应目录且文件名符合约定。
- **页面模板或静态文件 404**：检查业务工程 `app/public/` 目录及构建输出；模板路径需匹配 `dist/entry.:page.tpl`。
- **端口占用**：可通过环境变量 `PORT`、配置文件 `port` 或 `serverStart({ port })` 切换端口（默认 `8080`）。

## 开发规范

各功能部分的需求、实现计划和任务清单保存在 `sdd/`。开始对应部分的实现前，请先阅读该部分文档。

## License

本项目 `package.json` 声明的许可证为 ISC。发布或使用前请确认其与源文件版权声明及项目实际授权一致。
