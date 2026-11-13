import { createHash } from 'node:crypto';
import type { Citation } from '../contracts';
import type { VectorQueryResult } from '../store/store.interface';

/** 非序列化凭据：模型或其他工具返回相同字段也不会被当作真实检索结果。 */
const verified = new WeakMap<object, Citation[]>();

/**
 * 将向量命中项转换为模型和 HTTP 可以消费的检索结果。
 * filePath 与 ragRoot 是索引维护使用的本地路径，输出只保留公开元数据。
 * citation 标记可由模型原样写入答案，结构化来源通过对象身份登记到 WeakMap。
 */
export function retrievalOutput(hits: VectorQueryResult[]) {
  const citations = hits.map(hit => ({
    // 文本变化时生成新标记，历史 Trace 与重建后的切片不会被混淆。
    ref: createHash('sha256').update(JSON.stringify([hit.id, hit.text])).digest('hex').slice(0, 24),
    docId: hit.docId,
    chunkId: hit.id,
    score: hit.score,
  }));
  const output = { hits: hits.map((hit, index) => {
    const { filePath: _filePath, ragRoot: _ragRoot, ...meta } = hit.meta ?? {};
    return { ...hit, meta, citation: `[cite:${citations[index].ref}]` };
  }) };
  verified.set(output, citations);
  return output;
}

/** 从原始工具结果读取可信引用。复制或反序列化得到的同形对象无法取得登记数据。 */
export function readRetrievalCitations(output: unknown): Citation[] | undefined {
  return output && typeof output === 'object' ? verified.get(output) : undefined;
}

/**
 * 提取答案里实际出现的标记，与本次运行的候选引用逐一匹配。
 * 相同标记只返回一次并保留首次出现顺序。无法确认来源的标记不会进入 citations。
 */
export function collectCitations(output: string, candidates: Citation[]): Citation[] {
  const byRef = new Map(candidates.map(citation => [citation.ref, citation]));
  const references = new Set(Array.from(output.matchAll(/\[cite:([a-f0-9]{24})\]/g), match => match[1]));
  return [...references].flatMap(ref => byRef.get(ref) ?? []);
}
