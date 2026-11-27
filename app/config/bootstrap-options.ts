import type { NonceStoreOptions } from '../ai/access/nonce-store';
import type { AgentRunAccess, EmbeddingProvider, LlmProvider } from '../ai/contracts';
import type { GuardrailRuleSet } from '../ai/guardrail/guardrail.interface';
import type { McpConfig } from '../ai/mcp/mcp.types';
import type { RagOptions } from '../ai/rag/rag.interface';
import type { RedisLikeClient } from '../ai/store/reference/redis-store';
import type { MemoryStore, TraceStore, VectorStore } from '../ai/store/store.interface';
import type { ConfigService } from './config.service';

export interface LlmModelOptions {
  provider?: string;
  baseURL?: string;
  model?: string;
  apiKey?: string;
  use?: LlmProvider | (new (config: LlmModelOptions) => LlmProvider);
}

export interface LlmOptions {
  default?: string;
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

export interface AiToolsOptions {
  serviceInvoke?: Record<string, string[]>;
  serviceInvokeApproval?: boolean;
}

export interface AiRuntimeOptions {
  maxIterations?: number;
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
