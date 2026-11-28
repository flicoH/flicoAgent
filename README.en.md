# flicoAgent

[中文](README.md) | English

flicoAgent is a NestJS-based application framework kernel providing project configuration, page and static asset serving, automatic business module discovery, and optional LLM, Agent, Skill, MCP, RAG, and conversation memory capabilities. The frontend uses Vue 3, Vite, and Element Plus.

This repository contains the framework source code and example pages. The framework can also be installed as an npm package dependency in a business application, which provides its own configuration, pages, and compiled module artifacts following the conventions below.

## Overview

- NestJS HTTP server listening on port `8080` by default (configurable via `port` / `PORT` with graceful shutdown)
- Environment-based configuration loading via `_ENV` or `__ENV`
- Automatic discovery of business `dist/modules/**/*.module.js`, `dist/skills/**/*.skill.js`, and `dist/agents/**/*.agent.js`
- Vue 3 + Vite multi-page builds with Nunjucks page templates
- Configurable OpenAI-compatible LLM (with inference params, primary/fallback routing, and circuit breaker), structured Agent output (`outputSchema`), Embedding, MCP tools, RAG, Guardrail, Memory, and Trace
- Built-in file-based Trace, Memory, and Vector store implementations
- `flico-agent-eval` offline regression evaluation CLI with JSON reports and CI exit codes

## Clone and Run from GitHub

Requires Node.js 22.22.3 (specified in `.nvmrc`) and npm 10.

```bash
git clone --branch feature/agent https://github.com/flicoH/flicoAgent agent
cd agent
nvm install  # If using nvm; reads .nvmrc
nvm use      # Skip these two nvm commands if the required Node.js version is already active
npm ci
npm run build
node -e "require('./index').frontendBuild('production')"
node -e "require('./index').serverStart()"
```

`npm run build` compiles the backend to `dist/`. The frontend build generates `app/public/dist/entry.dashboard.tpl` and static assets under `app/public/dist/prod/`. These files must be generated locally after cloning.

Open the [sample Dashboard](http://localhost:8080/view/dashboard), or run in another terminal:

```bash
curl --fail --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  http://localhost:8080/view/dashboard
```

Returning `200` confirms Nest rendered the page template successfully. This check requires no database or model API keys. Dashboard business data and features still depend on project configuration, business data, and API signature verification.

### Frontend Development Mode

Run `npm run build` first, then run two terminals from the repository root:

```bash
# Terminal 1: Vite dev server generating templates that reference dev assets
node -e "require('./index').frontendBuild('local')"

# Terminal 2: Nest server
node -e "require('./index').serverStart()"
```

Still open `http://localhost:8080/view/dashboard`; Vite serves dev assets from `http://127.0.0.1:9002`. After finishing development, re-run the production frontend build to generate templates referencing production assets.

## Using as a Business Project Dependency

Once published to npm, install it in your business project:

```bash
npm install @flicoh/agent
```

Prepare the business directory structure. The framework looks up configuration, static pages, build artifacts, and data directories under `process.cwd()`:

```text
business-app/
├── config/
│   ├── config.default.js
│   ├── config.local.js       # Local secrets; do not commit
│   ├── config.beta.js        # Optional
│   └── config.prod.js        # Optional
├── app/
│   ├── public/               # Page templates and static files
│   └── pages/                # Business Vue/Vite pages (optional)
├── src/
│   ├── modules/              # Business Nest modules (optional)
│   ├── skills/               # Skill definitions (optional)
│   └── agents/               # Agent definitions (optional)
└── dist/                     # Compiled business artifacts
    ├── modules/**/*.module.js
    ├── skills/**/*.skill.js
    └── agents/**/*.agent.js
```

Start from the business project root. If your project has TypeScript business modules, Skills, or Agents, compile them to the `dist/` paths above first:

```bash
node -e "require('@flicoh/agent').serverStart()"
```

The framework scans Nest modules in `dist/modules/`, along with Skill and Agent definitions; missing directories result in empty extensions for the corresponding capabilities. Business Nest modules must export classes decorated with Nest module metadata; Skill and Agent files must use `default export` matching their interface definitions. Agents can reference Prompt modules relative to their compiled file locations.

If the business project builds frontend assets using the Vite configuration provided by this package:

```bash
node -e "require('@flicoh/agent').frontendBuild('local')"       # Dev server
node -e "require('@flicoh/agent').frontendBuild('production')"  # Production build
```

## Configuration

Copy or create `config/config.default.js`. Framework defaults live in `config/config.default.js` inside the package and can be overridden in your business `config/`. Loading precedence from lowest to highest is: framework defaults, business `config.default.js`, current environment config, and `serverStart(options)` bootstrap options. The `ai` and `agentConfig` objects are deep-merged; other top-level keys override earlier layers. TypeScript projects can import configuration and extension contracts such as `BootstrapOptions`, `AiOptions`, `RagOptions`, `RagMode`, `VectorStore`, and `ConfigService` from `@flicoh/agent` or `@flicoh/agent/nest`.

Environment selection:

| Environment Variable | Business Config Loaded | Default |
| --- | --- | --- |
| `_ENV` | `local` → `config.local.js`, `beta` → `config.beta.js`, `production` → `config.prod.js` | `local` |
| `__ENV` | Same as above; used only when `_ENV` is unset | `local` |

Environment config files live under `config/` in the working directory and are skipped if missing. `config.bate.js` in this repo is a legacy filename; pre-release overrides must use `config.beta.js`.

Example `config/config.default.js`:

```js
module.exports = {
  name: 'my-business-app',
  // Optional: page routing and other business settings
  apiSignVerify: {
    // Only list API paths intentionally exempt from signature verification
    whiteList: [],
  },
};
```

Example `config/config.local.js` (never commit real secrets to Git):

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
    // Writable data directories relative to the business project root
    store: {
      trace: 'data/trace',
      memory: 'data/memory',
      vector: 'data/vector.json',
    },
  },
};
```

LLM/Embedding API keys are only required when the corresponding capability is invoked. Embedding providers support `dashscope-compatible` and `openai-compatible`; built-in LLM provider is `openai-compatible`, supporting `temperature`, `maxTokens`, `topP`, `timeoutMs`, `fallbacks`, and `circuitBreaker` across global `ai.llm`, per-model, and `AgentDefinition` levels (see [Agent Operations Guide](docs/agent-operations.md#llm-推理参数主备-fallback-与熔断)). `ai.mcp` is disabled by default; configure servers and enable it to use MCP. Business options can also be passed via `require('@flicoh/agent').serverStart({ name: 'my-app' })`.

## Pages and Endpoints

- Nest HTTP server listens on port `8080`.
- The page controller resolves `/view/:page` to `app/public/dist/entry.:page.tpl` in the business project.
- Static assets are served from `app/public/` in the business project.
- Built-in project API paths include `/api/project`, `/api/project/list`, and `/api/project/model_list`.
- Project and business APIs use `s_sign` and `s_t`. `apiSignVerify.whiteList` exempts specific business API paths.
- AI APIs use separate authorization; see [OpenAPI](docs/openapi.json) for contracts. For run management, knowledge base, approvals, delegation, and CI integration, see [Agent Operations Guide](docs/agent-operations.en.md).

Page templates and business routes depend on business project config and artifacts; cloning this framework alone does not include business project data or database contents.

### AI API Authentication

Browsers continue to use existing signature headers. Business apps configure `ai.access.authorize(request)`, which validates the active login session and returns `{ scope, agents?, skills?, ragRead?, ingest? }`. `scope` is generated server-side to isolate threads and Traces. Use `agents` to restrict runnable Agents and `skills` to restrict directly invocable Skills. Returning `null` rejects the request.

For service-to-service calls, configure `ai.access.keys.<keyId>` on the server with `{ secret, scope?, agents?, skills?, ragRead?, ingest? }`. Clients send the following headers:

| Header | Value |
| --- | --- |
| `x-agent-key-id` | Caller key ID |
| `x-agent-nonce` | Unique random value per request (e.g., UUID) |
| `s_t` | 13-digit Unix millisecond timestamp |
| `s_sign` | Hex HMAC-SHA256 of the message below |

The message to sign concatenates `keyId`, uppercase HTTP method, request path with raw query string, `s_t`, `nonce`, and the hex SHA-256 of the raw request body, joined by newlines (empty body hashes the empty byte sequence). Signatures allow a 5-minute clock skew window, and nonces prevent replay within a single process. Multi-instance deployments can validate nonces at the API gateway.

Legacy HTTP threads and Traces lack authorization ownership and must be migrated by the business app with explicit ownership. Trace records include `scope`. Thread storage keys use `scope-` followed by the hex SHA-256 of `JSON.stringify([scope, threadId])`.

### SSE and Storage

- Agent streams emit `start`, `step`, and `delta`, ending with `done` on success. On `delta_reset`, clear temporary answer text while keeping steps. Chat streams emit `delta` and `done` (plus `delta_reset` when falling back mid-stream). Failures after stream start are returned as `error` events, and heartbeats are sent while idle.
- Skill and Tool `inputSchema` definitions are validated before execution. `ai.tools.serviceInvoke` maps service names to arrays of exposed method names, e.g., `{ ProjectService: ['getProjectDetail'] }`.
- `ai.store.trace.use`, `ai.store.memory.use`, and `ai.store.vector.use` accept store instances or factories taking `ConfigService`. Multi-instance session stores can implement `MemoryStore.runTurn` to coordinate turns with a shared lock. Default file stores target single-instance deployments.
- The knowledge base supports document listing, index deletion, rebuilds, retrieval preview, Wiki topic page reading, and chunk location. Sources can come from a file directory or MySQL, and vector indexes support file, MySQL, and Qdrant backends. Retrieval supports raw `rag`, LLM `wiki`, and `hybrid` modes (`ai.rag.mode`). See [RAG Knowledge Base](docs/agent-operations.en.md#rag-knowledge-base) for connection config and citation lookup.

## npm Scripts

| Script | Description |
| --- | --- |
| `npm run build` | Compile Nest/TypeScript code to `dist/` |
| `npm run build:watch` | Watch mode compilation |
| `npm run eval -- --help` | Show offline evaluation CLI help (run `npm run build` first) |
| `npm test` | Run Mocha tests (`__ENV=local`) |
| `npm run lint` | Run ESLint on JS/Vue files |

## Directory Structure

| Path | Contents |
| --- | --- |
| `app/main.ts`, `app/app.module.ts` | Nest bootstrap and module assembly |
| `app/modules/` | Built-in project, view, and fallback modules |
| `app/ai/` | AI Runtime, LLM, Embedding, RAG, MCP, Skill, Agent, and store interfaces |
| `app/pages/` | Framework Vue pages and components |
| `app/public/` | Framework public assets and templates |
| `app/vite/` | Vite multi-page build config |
| `config/` | Framework default and environment configs |
| `model/` | Model entrypoints |
| `test/` | Nest and AI unit/integration tests |

### Token Usage

Agent synchronous responses, SSE `done` payloads, and Trace records can all include `usage` (`inputTokens`, `outputTokens`, `totalTokens`). Usage is recorded once per model call even when multiple tools are requested in that turn. Planning steps in Trace show per-turn usage, where `usage: null` means the provider did not report usage for that turn. Custom providers can report usage via `LlmChatResult.usage`.

Query single-run consumption via `GET /api/ai/trace/{runId}/usage`, returning `{ success: true, data: { runId, usage } }`. Totals only sum usage actually reported by models; runs without reported usage return `usage: null`.

### Agent Loop Modes

Select the execution loop mode via `AgentDefinition.mode` in `app/agents/*.agent.ts`. Defaults to `react` when omitted.

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

| `mode` | Execution Flow |
| --- | --- |
| `react` | Iteratively selects tools and observes results until producing a final answer |
| `plan-and-execute` | Generates an ordered JSON step list, executes each step in turn, and synthesizes results |
| `reflection` | Generates a draft, reviews it, revises on feedback if needed, and re-reviews |

`maxReflectionRevisions` defaults to `1`; setting `0` reviews only once. If review fails after reaching the revision limit, the final draft is returned and the review step records `REFLECTION_LIMIT`. Plan-and-Execute follows the initially generated steps for that run. Dedicated planning, review, and synthesis stages have no tool execution permissions.

All model stages count toward `ai.runtime.maxIterations`, and toward the shared run-tree budget when delegation is used. Reflection requires at least four model calls to complete one revision and re-review (plus any tool-call turns). Child Agents use their own `mode`. Sync and SSE endpoints still invoke by Agent name, and `GET /api/ai/agent/graph?mode=reflection` inspects the topology of a given mode.

### Structured Output (`outputSchema`)

Declare `outputSchema` (JSON Schema) and optional `maxOutputRetries` (default `2`) on `AgentDefinition` to automatically inject schema instructions, validate final JSON strictly with `ajv`, and trigger bounded repair retries when output is malformed. On success, synchronous runs, SSE `done`, and Trace records return both canonical JSON string `output` and parsed `structuredOutput`; when retries are exhausted, the terminal step records `INVALID_STRUCTURED_OUTPUT`.

### Parallel Tool Execution & Built-in General Toolkit

- **Bounded Parallel Tool Calls**: Multi-call turns (including concurrent `agent-delegate` sub-agents) run with bounded concurrency (`ai.runtime.toolConcurrency` or per-Agent `toolConcurrency`, default `4`), placing an automatic concurrency barrier before any approval-required capability and persisting steps/observations in deterministic original order.
- **Unified Timeout & Output Truncation**: All Skills, built-in Tools, and MCP Tools are guarded by `ai.tools.timeoutMs` (default `30000`, returning `TOOL_TIMEOUT`) and `ai.tools.maxOutputChars` (default `16000`, flagging `truncated: true`), with per-capability overrides.
- **Built-in General Tools**: Alongside `retrieve` and `service-invoke`, adds SSRF-hardened `http-request` (default-deny host/method allowlists, private-network blocking, redirect re-validation, streaming byte cap), read-only `sql-query` (single-statement read-only SQL check, CTE-aware table ACL, row limit), and zero-`eval` `calculator`.

### Token-Budget Memory, Summarization & Thread Management APIs

- **Token Budget & Incremental Summarization**: Configure `maxContextTokens` and `summarization: { enabled: true }` under `ai.store.memory` (or `ai.memory`) to trim historical turns by multilingual token budget and incrementally summarize older turns into persistent `summary` state (automatically injected as context on subsequent turns, with graceful fallback on summarizer failure).
- **Scoped Thread Management APIs**: Exposes `GET /api/ai/threads`, `GET /api/ai/threads/:threadId`, `PATCH /api/ai/threads/:threadId`, `POST /api/ai/threads/:threadId/clear`, and `DELETE /api/ai/threads/:threadId` with strict `scope` isolation across File, MySQL, and Redis `MemoryStore` drivers.

### Multi-Agent Delegation

Configuring `delegates` on an Agent allows calling listed child Agents through the reserved `agent-delegate` tool. Parent execution steps expose `childRunId`, and child Traces include `parentRunId`, `rootRunId`, and `delegationDepth`. See [Agent Delegation Guide](docs/agent-delegation.en.md) for configuration and offline testing.

### Offline Evaluation

Install the `@flicoh/agent` version containing the CLI in your business project, start the test server, and provide `AGENT_EVAL_KEY_ID` and `AGENT_EVAL_SECRET` via environment variables:

```sh
npx flico-agent-eval --suite ./eval/cases.json --url http://localhost:8080 --out ./eval-report.json
```

The CLI sequentially invokes the synchronous Agent endpoint to verify tool calls, RAG citations, permission rejections, and multi-turn memory, returning CI exit codes. See [CI Offline Evaluation](docs/agent-operations.en.md#ci-offline-evaluation) for server configuration, case schema, and report fields.

## Troubleshooting

- **Missing model API key**: Verify the active environment config file exists, the environment name is set properly, and `apiKey` resolves to a valid environment variable.
- **Business modules, Skills, or Agents not loaded**: Ensure the process starts from the business project root and compiled outputs exist at `dist/modules/`, `dist/skills/`, and `dist/agents/` matching naming conventions.
- **Page template or static asset 404**: Check the business project's `app/public/` directory and build output; template paths must match `dist/entry.:page.tpl`.
- **Port in use**: Override the default port `8080` via `PORT`, config `port`, or `serverStart({ port })`.

## Development Spec

Requirements, implementation plans, and task lists for each part live in `sdd/`. Read the corresponding documents before starting implementation.

## License

`package.json` declares the license as ISC. Confirm consistency with source file copyright headers and project licensing before publishing or redistributing.
