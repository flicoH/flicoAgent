# Agent Operations Guide

[中文](agent-operations.md) | English

All endpoints below use the existing AI request signature or business session authorization. See [OpenAPI](openapi.json) for full schemas.

| Method & Path (all prefixed with `/api/ai`) | Usage |
| --- | --- |
| `POST /agent/runs` | Send `{ agent, input, threadId? }`; save `data.runId` upon receiving `202` |
| `GET /agent/runs?limit=20&offset=0` | List run summaries accessible to the current scope |
| `GET /agent/runs/:runId` | Inspect status, steps, output, token usage, pending approval, and failure reason |
| `GET /agent/runs/:runId/events?after=0` | SSE replay of persisted steps followed by live progress; pass the last received `sequence` as `after` on reconnect |
| `POST /agent/runs/:runId/cancel` | Cancel a queued, running, or waiting-approval run |
| `POST /agent/runs/:runId/approval` | Send `{ approvalId, approved }`; authorization requires `approve: true` |
| `GET /rag/documents` | List indexed documents and chunk counts for the active knowledge source |
| `DELETE /rag/documents` | Send `{ docId }` to delete indexed chunks while keeping the original source |
| `POST /rag/rebuild` | Rebuild the index using the configured source, chunker, and embedding provider |
| `POST /rag/preview` | Send `{ query, topK? }` to preview retrieval hits and citation markers |
| `GET /rag/chunk?id=...` | Pass a URL-encoded `citations[].chunkId` to locate the chunk in the active index |
| `GET /rag/wiki/pages` | List published Wiki topic pages, titles, and section counts |
| `GET /rag/wiki/page?id=...` | Read a Wiki page's Markdown, related pages, and source evidence per section |

Async SSE streams emit `start`, sequenced `step`, status transition `status`, and terminal `done`. They replay structured progress; for token-by-token output, continue using `POST /agent/run/stream`. Synchronous and legacy streaming endpoints retain `runId`, `output`, `steps`, and `threadId`. When approval is required, responses return `status: "waiting_approval"` and `approval`; after submitting a decision, fetch the final result via run details or async SSE.

Run statuses are `queued`, `running`, `waiting_approval`, `succeeded`, `failed`, `cancelled`, or `interrupted`. `modelDurationMs` sums planning call durations for that run; child runs are measured independently. When a provider does not report token usage, no estimated value is filled in. Both unauthorized and nonexistent runs return `404`.

Set `approval: 'required'` on a business Skill or Tool definition. Enable approval for built-in `service-invoke` via `ai.tools.serviceInvokeApproval: true`, and for MCP tools via per-server `approvalTools: ['tool-name']`. Each approval ID corresponds to a single pending call; duplicate decisions return `409`. Rejections feed a failure observation back to the model and allow execution to continue. External write operations can use `idempotencyKey` from the Skill/Tool context for downstream idempotency.

See [Agent Delegation Guide](agent-delegation.en.md) for delegation config, budget limits, and offline verification.

File stores and the in-process background queue target single-writer deployments. Up to 4 background tasks execute concurrently; when queued + running tasks reach 100, new submissions or approvals return `429` for retry. Waiting-approval runs can resume after process restart; queued or running runs are marked `interrupted` on next query. Cancellation propagates to models and capabilities supporting `AbortSignal`, but cannot undo already executed external side effects. Custom `TraceStore` implementations must implement `list` to support listing runs.

## RAG Knowledge Base

Configure `ai.embedding`, the document source, and the vector store, then call `POST /api/ai/rag/rebuild` to build the index. Sources and indexes are configured independently. When an Agent enables the built-in `retrieve` tool, Agent retrieval and preview share the exact same configured index.

| Config | Values | Behavior |
| --- | --- | --- |
| `ai.rag.source.driver` | `file` (default), `mysql` | Indexes UTF-8 Markdown, TXT, JSON files or rows from the MySQL documents table. File directory resolves `ai.store.vector.fixturesPath`, then `ai.rag.fixtures.path`, defaulting to `data/fixtures`. |
| `ai.store.vector.driver` | `file` (default), `mysql`, `qdrant` | Determines where chunks, vectors, and location metadata are stored. MySQL stores vectors as JSON and ranks with cosine similarity in-app; Qdrant performs similarity search inside the vector database. |

### MySQL and Qdrant Configuration

The setup below stores raw documents in MySQL and serves vector search from Qdrant. The MySQL connection reuses the framework's `db` configuration. Run [rag-mysql.sql](rag-mysql.sql) on MySQL 8, then insert documents into `flico_rag_documents` under your chosen `collection` (`doc_id` is a stable ID within the collection, `body` is the source text). Local files can also remain the source and rebuild into a database vector index using the same endpoints.

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
VALUES ('support', 'policy/refunds.md', 'Refund requests must be submitted within 30 days.');
```

Vector dimensions must match the `ai.embedding` model. Qdrant creates a collection alias per source and publishes rebuilds atomically by switching the alias. The connection requires permissions to create collections, update aliases, and read/write points. A single app process should perform deletes and rebuilds for a Qdrant namespace while other instances read. Projects and environments sharing a database should use distinct `namespace` values, or share the same namespace and source to reuse an index. [Qdrant Aliases API](https://api.qdrant.tech/api-reference/aliases/update-aliases)

To store the vector index in MySQL as well, set `ai.store.vector` to `{ driver: 'mysql', namespace: 'support-prod' }`. MySQL publishes rebuilds transactionally and serializes writes within the same namespace. Vector table write permissions can be granted separately; reading raw documents only needs `SELECT` on the source table.

### LLM Wiki and Hybrid Retrieval

Set `ai.rag.mode` and run `POST /api/ai/rag/rebuild`. Preview and the built-in `retrieve` tool share the same mode and index.

| Mode | Retrieved Content |
| --- | --- |
| `rag` (default) | Raw source chunks. Rebuilds publish raw chunk indexes. |
| `wiki` | LLM-compiled and persisted Markdown topic sections. Raw source chunks remain locatable via each section's source IDs. |
| `hybrid` | Queries raw chunks and Wiki sections independently on the same index snapshot and merges candidates into one TopK via Reciprocal Rank Fusion (RRF). `score` is the fused rank score. |

For example, configure `ai.rag` as `{ mode: 'hybrid', wiki: { model: 'knowledge-editor' } }`, where `knowledge-editor` is a key in `ai.llm.models`. Omitting `wiki.model` defaults to `ai.llm.default`. When upgrading from a raw index, switch modes and run one rebuild. MySQL reuses existing tables; Qdrant rebuilds add keyword payload indexes for Wiki filtering on new collections.

Wiki compilation feeds source chunks to the model in batches. The model generates topic sections with source chunk IDs and reuses existing catalog page IDs for matching topics. Sections from different documents can merge into the same topic page. Unchanged source units are reused on subsequent rebuilds. Returned `wiki.pages` and `wiki.sections` report total published counts, `wiki.generatedSections` reports newly compiled sections in this rebuild, and `chunks` continues counting raw source chunks written.

Before publication, section source references are validated against their compilation unit and nonexistent internal page links are stripped. Raw chunks and Wiki sections publish together as one generation. If compilation fails, returns invalid source references, or Wiki embedding fails, the entire rebuild rolls back and preserves the previous index. If a single document fails to read or embed, its previous raw chunks and Wiki sections are retained. Deleting a document index cascades to its generated Wiki sections while keeping sections contributed by other documents; if the source still exists, the next rebuild re-indexes it.

Wiki hits carry `meta.kind: 'wiki'` and `meta.wiki`. When the answer body cites a Wiki hit, `citations` includes `kind: 'wiki'` and `pageId`. Locating by `chunkId` returns `meta.wiki.sources` containing source chunk IDs, versions, source text snapshots, and character ranges when available. Historical Traces preserve these snapshots so evidence remains inspectable after document updates.

### Management and Citations

Management endpoints accept service-to-service signatures from `ai.access.keys` or session authorization from `ai.access.authorize`. Listing, preview, chunk lookup, and reading Wiki pages require `ragRead: true` or `ingest: true`. Deleting and rebuilding require `ingest: true`. Access to the `retrieve` tool is controlled per Agent via its tool allowlist.

- **Rebuild** synchronizes the index with the configured source. Succeeded documents replace prior chunks; removed or empty documents are purged. Documents failing read or embedding retain their last indexed version. Response fields include `ingested` (scanned documents), `chunks` (raw chunks written), `succeeded`, `skipped`, and `failed`. Source scan errors preserve the old index; a missing local directory returns `404`; a valid empty source clears that source's index.
- **Delete** removes indexed chunks by `docId` and returns `removed` count. Source data is preserved and re-indexed on the next rebuild. Missing documents return `404`.
- **Preview & Locate** send `{ "query": "refund policy", "topK": 3 }` to preview, then pass URL-encoded `hits[].id` to `GET /api/ai/rag/chunk?id=...`. Locate returns chunk text, citation marker, and `meta.version`. Files locate via `meta.relativePath`; MySQL locates via `meta.collection` and `docId`. The default chunker provides exact UTF-16 half-open `[start, end)` offsets usable with `source.slice(start, end)`. Legacy indexes or custom chunkers altering text may omit version or offsets. Similarity scores appear only in retrieval responses.
- **Answer Citations** Agents insert retrieved `[cite:...]` markers beside claims backed by evidence. The server collects matching chunks from successful `retrieve` tool steps in first-appearance order in the Markdown body, ignoring code blocks, inline code, escaped examples, HTML comments, link URLs, and draft-only markers. The same `citations` array is written to sync responses, SSE `done`, and Trace (omitted when empty).
- **Historical Citations** Live lookup queries only the active index; after a document updates or is deleted, old chunk IDs return `404`. Callers with Trace access can inspect the original snapshot inside the run's `retrieve` tool step via `GET /api/ai/trace/:runId`.

All three built-in backends continue serving the previous snapshot while a rebuild prepares. The default file store targets single-writer processes and swaps files atomically on publish. Legacy file index entries with valid file paths remain queryable and locatable until upgraded on the next rebuild. Custom backends can be plugged in via `ai.store.vector.use` (instance or factory): implement `syncDirectory`, `documents`, `removeDocument`, and `loadChunk` for management APIs, plus `wikiChunks`, pre-TopK source/kind filtering, cascade Wiki removal on `removeDocument`, and optional `queryHybrid` for Wiki and hybrid support.

Local regression tests run without external models using test stub embedders and LLMs:

```sh
npm run build
__ENV=local ./node_modules/.bin/mocha test/ai/rag.test.js
__ENV=local ./node_modules/.bin/mocha test/ai/rag-wiki.test.js
__ENV=local ./node_modules/.bin/mocha test/ai/api-hardening.test.js --grep 'RAG 管理接口|Wiki 管理|Wiki 模式'
```

Database integration tests run against dedicated MySQL and Qdrant test instances. Set `RAG_MYSQL_TEST_URL` for MySQL cases and `RAG_QDRANT_TEST_URL` (plus `RAG_QDRANT_TEST_KEY` if needed) for Qdrant cases; setting both also runs combined cases:

```sh
__ENV=local ./node_modules/.bin/mocha test/ai/rag-database.test.js
```

## CI Offline Evaluation

Copy the [example suite](../sdd/agent-operations/eval-suite.example.json) to `eval/cases.json` in your business project and adjust Agents, tool names, document IDs, and assertions. The CLI sequentially calls `POST /api/ai/agent/run` on your test server. For air-gapped environments, configure local models and embeddings on the test server.

Register CI signing credentials in the test server config. The example below allows `agent-eval` to run `support` while returning HTTP `403` for a registered `admin` Agent. Enabling `threadEnabled` allows multi-turn recall within a case:

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

Provide `AGENT_EVAL_SECRET` via CI secrets and set `AGENT_EVAL_KEY_ID=agent-eval`. The CLI generates a fresh nonce per request. `serverStart()` enables raw body capture automatically; when bootstrapping directly with `NestFactory.create()`, pass `{ rawBody: true }` for signature verification.

```sh
npx flico-agent-eval --suite ./eval/cases.json --url http://localhost:8080 --out ./eval-report.json
```

When running from source, execute `npm run build` first and pass the same flags to `npm run eval --`. Omitting `--out` writes JSON to stdout. Use `--timeout-ms` to set per-request timeout (default `60000` ms).

| Suite Field | Behavior |
| --- | --- |
| `cases[].id`, `agent`, `turns` | Unique case ID, Agent name, and ordered turns. Each case gets its own thread reused across its turns. |
| `turns[].input` | JSON value sent as Agent input. |
| `turns[].expectStatus` | Expected HTTP status code (defaults to any `2xx`). Use `403` to assert access denial. |
| `assert.toolsUsed` | Every listed capability must appear in a succeeded `tool` or `skill` step (exact name match). |
| `assert.citationDocIds` | Every listed `docId` must appear in structured `citations`. Knowledge base must be pre-indexed and answers must copy `retrieve` citation markers verbatim. |
| `assert.outputNotEmpty`, `assert.outputContains` | Checks non-empty output (`true`) or substring match. Array inputs for `outputContains` / `outputContainsAny` pass if any item matches. |
| `assert.guardrailBlocked` | Boolean checking whether a `guardrail` step occurred (alias: `blocked`). |
| `assert.stepsContain` | String or array checking whether steps contain any listed name. |

The report contains total/passed/failed counts, duration, per-turn HTTP status, `runId`, and assertion failures, omitting raw inputs, model outputs, and signing credentials. A failed turn does not stop remaining turns or cases. Waiting-approval responses count as evaluation failures.

| Exit Code | Meaning |
| --- | --- |
| `0` | All cases passed, or help displayed successfully. |
| `10` | At least one case failed (timeout, status mismatch, or assertion failure). |
| `20` | Invalid CLI arguments, missing signing env vars, or invalid suite file. |
| `30` | Unable to write JSON report to the target file or stdout. |

Business code can import `parseSuite` and `runSuite` from `@flicoh/agent/eval` and supply an async transport taking `{ agent, input, threadId }` and returning `{ status, body }`.
