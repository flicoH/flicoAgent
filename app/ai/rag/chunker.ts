import { Chunk, Chunker as IChunker, RagOptions } from './rag.interface';

/**
 * 框架默认纯函数文本切分实现
 *
 * 【约束规范】
 * 通过固定宽度的滑动窗口切分。位置使用 JavaScript 字符串的 UTF-16 下标，end 不包含在窗口内。
 * 切片文本会 trim；元数据中的 start/end 仍指向原始窗口，而不是 trim 后的文本范围。
 *
 * @param text 待切分文本
 * @param options 切分参数 { size, overlap }
 * @param meta 基础元数据
 * @returns 切片数组
 */
export function chunk(
  text: string,
  options: { size: number; overlap: number },
  meta?: Record<string, unknown>,
): Chunk[] {
  const chunks: Chunk[] = [];
  if (!text || typeof text !== 'string') {
    return chunks;
  }

  // 限制 overlap 小于 size，确保每次循环至少向前移动一个位置。
  const size = Math.max(1, options.size);
  const overlap = Math.max(0, Math.min(options.overlap, size - 1));
  const step = Math.max(1, size - overlap);

  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    const piece = text.slice(start, end).trim();

    if (piece) {
      chunks.push({
        text: piece,
        meta: {
          ...meta,
          start,
          end,
        },
      });
    }

    if (end >= text.length) {
      break;
    }
    start += step;
  }

  return chunks;
}

/**
 * 依据 RAG 配置决定当前生效的切分器 (Chunker)
 *
 * 【业务可覆盖纪律】
 * 若配置了 `ai.rag.chunker.use`，优先实例化或直接使用业务方注入的实现（同 ai.llm 的 use: 纪律），
 * 否则使用框架默认切分算法。
 *
 * @param ragOptions 生效的 RAG 配置
 * @returns 具备 chunk 方法的切分器实例
 */
export function resolveChunker(ragOptions: RagOptions): IChunker {
  if (ragOptions.chunker?.use) {
    const custom = ragOptions.chunker.use;
    if (typeof custom === 'function') {
      // 先按构造器调用；抛错后再按普通工厂函数调用，参数均为完整 RAG 配置。
      try {
        return new (custom as new (opts?: unknown) => IChunker)(ragOptions);
      } catch {
        return (custom as any)(ragOptions);
      }
    }
    return custom;
  }

  const size = ragOptions.chunk?.size!;
  const overlap = ragOptions.chunk?.overlap!;

  return {
    chunk: (text: string, meta?: Record<string, unknown>) => {
      return chunk(text, { size, overlap }, meta);
    },
  };
}

/**
 * 框架默认文档切分器类实现
 */
export class Chunker implements IChunker {
  chunk(text: string, meta?: Record<string, unknown>): Chunk[] {
    // 供默认注入或简单调用，实际由 RetrieverService 通过 resolveChunker 统一调度
    return chunk(text, { size: 500, overlap: 50 }, meta);
  }
}
