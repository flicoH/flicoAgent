import type { BuiltinToolFactory } from '../tool.interface';
import { ConfigService } from '../../../config/config.service';
import { resolveRagOptions } from '../../rag/internal/load-rag-config';
import { RetrieverService } from '../../rag/retriever.service';

/**
 * 解析并校验 retrieve 工具入参
 */
function parseRetrieveInput(input: unknown): string {
  if (typeof input === 'string') {
    return input.trim();
  }
  if (input && typeof input === 'object') {
    const q = (input as { query?: unknown }).query;
    if (typeof q === 'string' && q.trim()) {
      return q.trim();
    }
  }
  throw new Error('retrieve tool input requires a query string');
}

/**
 * 框架内置工具：知识库检索工具 (retrieve)
 *
 * 【约束规范】
 * 1. name 与 description 优先从 ai.rag.tool 读取，未配置时使用框架通用默认文案；
 * 2. inputSchema 仅开放 query 字段，topK 不开放给模型猜，由系统配置决定；
 * 3. execute 调用 RetrieverService.retrieve，标记 source: 'builtin'；
 * 4. output 包含 hits[]: { docId, text, score, ... }。
 */
const retrieveTool: BuiltinToolFactory = ({ moduleRef }) => {
  const config = moduleRef.get(ConfigService, { strict: false });
  const ragOptions = resolveRagOptions(config);

  const name = ragOptions.tool?.name || 'retrieve';
  const description = ragOptions.tool?.description
    || '从私有知识库检索相关片段；回答必须引用返回的 docId/text';

  return {
    name,
    description,
    source: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '检索关键词或自然语言提问',
        },
      },
      required: ['query'],
    },
    async execute(input: unknown): Promise<unknown> {
      const query = parseRetrieveInput(input);
      const retriever = moduleRef.get(RetrieverService, { strict: false });
      if (!retriever) {
        throw new Error('RetrieverService is not available in moduleRef');
      }

      return retriever.retrieve(query);
    },
  };
};

export default retrieveTool;
