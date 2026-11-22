import type { AgentRunAccess, EmbeddingProvider, LlmProvider } from '../ai/contracts';
import type { GuardrailRuleSet } from '../ai/guardrail/guardrail.interface';
import type { McpConfig } from '../ai/mcp/mcp.types';
import type { RagOptions } from '../ai/rag/rag.interface';
import type { VectorStore } from '../ai/store/store.interface';
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
  path?: string;
  maxTurns?: number;
  threadEnabled?: boolean;
}

export interface AiStoreOptions {
  trace?: string;
  vector?: string | VectorStoreOptions;
  memory?: string | MemoryStoreOptions;
}

export interface AgentAccessOptions {
  authorize?: (request: any) => AgentRunAccess | null | Promise<AgentRunAccess | null>;
  keys?: Record<string, AgentRunAccess & { secret: string }>;
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
  mcp?: Partial<McpConfig>;
  guardrail?: GuardrailRuleSet & { rules?: GuardrailRuleSet };
  runtime?: AiRuntimeOptions;
  access?: AgentAccessOptions;
  agentConfig?: AgentConfigOptions;
}

export interface BootstrapOptions {
  name?: string;
  homePage?: string;
  db?: unknown;
  apiSignVerify?: ApiSignVerifyOptions;
  agentConfig?: AgentConfigOptions;
  ai?: AiOptions;
  [key: string]: unknown;
}

export const BOOTSTRAP_OPTIONS = Symbol('BOOTSTRAP_OPTIONS');
