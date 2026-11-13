import { resolve } from 'node:path';
import { ConfigService } from '../../../config/config.service';
import { RagOptions } from '../rag.interface';

/**
 * 根配置结构映射
 */
interface AiConfig {
  store?: {
    vector?: {
      fixturesPath?: string;
    };
  };
  rag?: RagOptions & {
    fixtures?: {
      path?: string;
    };
  };
}

/**
 * 框架内置默认 RAG 配置项
 */
export const DEFAULT_RAG_OPTIONS: Required<Omit<RagOptions, 'chunker'>> = {
  chunk: {
    size: 500,
    overlap: 50,
  },
  topK: 3,
  tool: {
    name: 'retrieve',
    description: '从私有知识库检索相关片段；回答必须引用返回的 docId/text',
  },
};

/**
 * 解析待灌库的本地知识库知识目录绝对路径
 *
 * 【解析优先级纪律】
 * 1. 优先读取 `ai.store.vector.fixturesPath`（与 trace 同级配置纪律）；
 * 2. 缺省再读取 `ai.rag.fixtures.path`；
 * 3. 最后回退到 demo 相对路径 `data/fixtures`。
 *
 * @param config 全局配置服务
 * @returns 知识库文档目录绝对路径
 */
export function resolveRagFixturesPath(config: ConfigService): string {
  const ai = config.get<AiConfig>('ai');

  // 1. 优先读 ai.store.vector.fixturesPath
  const vectorFixtures = (ai?.store?.vector as any)?.fixturesPath
    ?? config.get<string>('ai.store.vector.fixturesPath');
  if (typeof vectorFixtures === 'string' && vectorFixtures.trim()) {
    return resolve(process.cwd(), vectorFixtures.trim());
  }

  // 2. 缺省读 ai.rag.fixtures.path
  const ragFixtures = ai?.rag?.fixtures?.path
    ?? config.get<string>('ai.rag.fixtures.path');
  if (typeof ragFixtures === 'string' && ragFixtures.trim()) {
    return resolve(process.cwd(), ragFixtures.trim());
  }

  // 3. Fallback demo 相对路径
  return resolve(process.cwd(), 'data/fixtures');
}

/**
 * 解析并与框架默认值深合并得到生效的 RAG 运行配置
 *
 * @param config 全局配置服务
 * @returns 合并后的完备 RagOptions
 */
export function resolveRagOptions(
  config: ConfigService,
): Required<Omit<RagOptions, 'chunker'>> & { chunker?: RagOptions['chunker'] } {
  const raw = config.get<AiConfig>('ai')?.rag
    ?? config.get<RagOptions>('ai.rag')
    ?? {};

  return {
    chunk: {
      size: raw.chunk?.size ?? DEFAULT_RAG_OPTIONS.chunk.size,
      overlap: raw.chunk?.overlap ?? DEFAULT_RAG_OPTIONS.chunk.overlap,
    },
    topK: raw.topK ?? DEFAULT_RAG_OPTIONS.topK,
    tool: {
      name: raw.tool?.name ?? DEFAULT_RAG_OPTIONS.tool.name,
      description: raw.tool?.description ?? DEFAULT_RAG_OPTIONS.tool.description,
    },
    chunker: raw.chunker,
  };
}
