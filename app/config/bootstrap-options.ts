import type { NonceStoreOptions } from '../ai/access/nonce-store';
import type { AgentRunAccess, EmbeddingProvider, LlmProvider } from '../ai/contracts';
import type { GuardrailRuleSet } from '../ai/guardrail/guardrail.interface';
import type { McpConfig } from '../ai/mcp/mcp.types';
import type { RagOptions } from '../ai/rag/rag.interface';
import type { RedisLikeClient } from '../ai/store/reference/redis-store';
import type { MemoryStore, TraceStore, VectorStore } from '../ai/store/store.interface';
import type { ConfigService } from './config.service';

export interface LlmGenerationOptions {
  /** 采样温度，默认 0 */
  temperature?: number;
  /** 单次生成最大输出 token 数 */
  maxTokens?: number;
  /** 核采样概率阈值 (0, 1] */
  topP?: number;
  /** 单次模型请求超时时间（毫秒） */
  timeoutMs?: number;
  /** timeoutMs 的别名 */
  timeout?: number;
  /** 单模型 SDK 内部最大重试次数；无 fallbacks 时默认 2，有 fallbacks 时默认 0 */
  maxRetries?: number;
}

export interface LlmCircuitBreakerOptions {
  /** 是否启用模型级熔断器 */
  enabled?: boolean;
  /** 触发熔断的连续可重试失败次数阈值，默认 3 */
  failureThreshold?: number;
  /** 熔断打开后的冷却时间（毫秒），默认 30000 */
  cooldownMs?: number;
  /** 半开状态允许并发探测的请求数，默认 1 */
  halfOpenMaxCalls?: number;
}

export interface LlmModelOptions extends LlmGenerationOptions {
  provider?: string;
  baseURL?: string;
  model?: string;
  apiKey?: string;
  /** 模型级备用模型注册名链（按顺序切备） */
  fallbacks?: string[];
  use?: LlmProvider | (new (config: LlmModelOptions) => LlmProvider);
}

export interface LlmOptions extends LlmGenerationOptions {
  default?: string;
  /** 全局默认备用模型注册名链 */
  fallbacks?: string[];
  /** 模型级熔断器配置 */
  circuitBreaker?: LlmCircuitBreakerOptions;
  models?: Record<string, LlmModelOptions>;
}

export interface EmbeddingModelOptions {
  provider?: string;
  baseURL?: string;
  model?: string;
  apiKey?: string;
  batchSize?: number;
  maxRetries?: number;
  use?: EmbeddingProvider | (new (config: EmbeddingModelOptions) => EmbeddingProvider);
}

export interface EmbeddingOptions extends EmbeddingModelOptions {
  default?: string;
  models?: Record<string, EmbeddingModelOptions>;
}

export type VectorStoreDriver = 'file' | 'mysql' | 'qdrant';
export type TraceStoreDriver = 'file' | 'mysql' | 'redis';
export type MemoryStoreDriver = 'file' | 'mysql' | 'redis';

export interface TraceStoreOptions {
  driver?: TraceStoreDriver;
  path?: string;
  namespace?: string;
  prefix?: string;
  ttlMs?: number;
  client?: RedisLikeClient;
  use?: TraceStore | ((config: ConfigService) => TraceStore | Promise<TraceStore>);
}

export interface VectorStoreOptions {
  driver?: VectorStoreDriver;
  path?: string;
  fixturesPath?: string;
  namespace?: string;
  url?: string;
  apiKey?: string;
  dimensions?: number;
  use?: VectorStore | ((config: ConfigService) => VectorStore | Promise<VectorStore>);
}

export interface MemorySummarizationOptions {
  /** 是否启用超长会话自动摘要压缩，默认 false */
  enabled?: boolean;
  /** 摘要压缩使用的模型注册名（对应 ai.llm.models 中的 key），缺省沿用 ai.llm.default */
  model?: string;
  /** 触发摘要压缩的估算 Token 阈值；未配置时优先取 maxContextTokens，否则默认 4000 */
  triggerTokens?: number;
  /** 压缩时原样保留的最新消息条数，默认 6（最小 2） */
  keepRecentMessages?: number;
  /** 单份历史摘要最大字符数，默认 2000 */
  maxSummaryChars?: number;
}

export interface MemoryStoreOptions {
  driver?: MemoryStoreDriver;
  path?: string;
  namespace?: string;
  prefix?: string;
  ttlMs?: number;
  lockTtlMs?: number;
  lockTimeoutMs?: number;
  lockTimeoutSeconds?: number;
  client?: RedisLikeClient;
  maxTurns?: number;
  /** 历史上下文最大估算 Token 预算（正整数，配置后自动按预算裁剪近期消息） */
  maxContextTokens?: number;
  /** 历史对话自动摘要压缩配置 */
  summarization?: MemorySummarizationOptions;
  threadEnabled?: boolean;
  use?: MemoryStore | ((config: ConfigService) => MemoryStore | Promise<MemoryStore>);
}

export interface AiStoreOptions {
  trace?: string | TraceStoreOptions;
  vector?: string | VectorStoreOptions;
  memory?: string | MemoryStoreOptions;
}

export interface AgentAccessOptions {
  authorize?: (request: any) => AgentRunAccess | null | Promise<AgentRunAccess | null>;
  keys?: Record<string, AgentRunAccess & { secret: string }>;
  nonceStore?: NonceStoreOptions;
}

export interface HttpToolOptions {
  /** 是否需要人工审批 */
  approval?: 'required';
  /** 允许访问的域名白名单（未配置或为空时默认拒绝所有请求；支持精确域名与 *.example.com 通配） */
  allowedHosts?: string[];
  /** 允许的 HTTP 方法，默认 ['GET', 'HEAD'] */
  allowedMethods?: string[];
  /** 是否允许访问私网/回环地址（默认 false，开启防 SSRF） */
  allowPrivateNetworks?: boolean;
  /** 单次请求超时时间（毫秒），默认 10000 */
  timeoutMs?: number;
  /** 单次响应最大读取字节数，默认 262144 (256KB) */
  maxResponseBytes?: number;
  /** 允许模型传入的自定义请求头白名单（小写匹配，默认禁止 host/cookie/authorization 等敏感头） */
  allowedHeaders?: string[];
  /** 服务端默认附加请求头（模型不可覆盖） */
  defaultHeaders?: Record<string, string>;
  /** 最大重定向跳数，默认 3（每跳均重新校验协议、Host 白名单与私网策略） */
  maxRedirects?: number;
}

export interface SqlToolOptions {
  /** 是否显式启用只读 SQL 查询工具，默认 false */
  enabled?: boolean;
  /** 是否需要人工审批 */
  approval?: 'required';
  /** 允许查询的表名白名单（配置后仅允许访问列出的物理表） */
  allowedTables?: string[];
  /** 禁止查询的敏感表名黑名单 */
  deniedTables?: string[];
  /** 单次最多返回行数，默认 100，上限 1000 */
  maxRows?: number;
  /** 单次查询超时时间（毫秒），默认 10000 */
  timeoutMs?: number;
  /** 可选自定义只读查询执行器（未指定时默认复用容器内的 DatabaseProvider.knex） */
  executor?: (sql: string, params: unknown[], signal?: AbortSignal) => Promise<unknown[]>;
}

export interface AiToolsOptions {
  serviceInvoke?: Record<string, string[]>;
  serviceInvokeApproval?: boolean;
  /** 全局默认单次工具/技能执行超时时间（毫秒），默认 30000 */
  timeoutMs?: number;
  /** 全局默认单次工具/技能输出最大字符数，默认 16000 */
  maxOutputChars?: number;
  /** 内置 http-request 工具配置 */
  http?: HttpToolOptions;
  /** 内置 sql-query 工具配置 */
  sql?: SqlToolOptions;
}

export interface AiRuntimeOptions {
  maxIterations?: number;
  /** 同轮多 tool_calls 的受控并发上限，默认 4（设为 1 时退化为严格串行） */
  toolConcurrency?: number;
  delegation?: {
    maxModelCalls?: number;
    maxDepth?: number;
    maxChildRuns?: number;
  };
}

export interface AgentConfigOptions {
  threadEnabled?: boolean;
  [key: string]: unknown;
}

export interface ApiSignVerifyOptions {
  whiteList?: string[];
}

export interface AiOptions {
  llm?: LlmOptions;
  embedding?: EmbeddingOptions;
  rag?: RagOptions;
  store?: AiStoreOptions;
  memory?: Pick<MemoryStoreOptions, 'path' | 'maxTurns' | 'maxContextTokens' | 'summarization' | 'threadEnabled'>;
  tools?: AiToolsOptions;
  mcp?: Partial<McpConfig>;
  guardrail?: GuardrailRuleSet & { rules?: GuardrailRuleSet };
  runtime?: AiRuntimeOptions;
  access?: AgentAccessOptions;
  agentConfig?: AgentConfigOptions;
}

export interface BootstrapOptions {
  name?: string;
  homePage?: string;
  port?: number;
  host?: string;
  shutdownHooks?: boolean;
  db?: unknown;
  apiSignVerify?: ApiSignVerifyOptions;
  agentConfig?: AgentConfigOptions;
  ai?: AiOptions;
  [key: string]: unknown;
}

export const BOOTSTRAP_OPTIONS = Symbol('BOOTSTRAP_OPTIONS');
