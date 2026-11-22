import type { VectorRecord, VectorQueryResult } from './store.interface';

function cosineSimilarity(a: number[], b: number[]): number {
  if (!b || a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function rankVectors(
  records: Iterable<VectorRecord>, embedding: number[], topK: number, requireMatchingDimensions: boolean,
): VectorQueryResult[] {
  if (!embedding?.length) return [];
  const scored: VectorQueryResult[] = [];
  for (const { id, docId, text, meta, embedding: vector } of records) {
    if (requireMatchingDimensions && vector?.length !== embedding.length) continue;
    scored.push({ id, docId, text, meta, score: cosineSimilarity(embedding, vector) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, topK));
}
