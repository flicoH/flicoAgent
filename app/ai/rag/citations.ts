import { createHash } from 'node:crypto';
import type { Citation, Step } from '../contracts';
import type { VectorQueryResult } from '../store/store.interface';

function citationFor(hit: VectorQueryResult): Citation {
  const hash = createHash('sha256').update(JSON.stringify([hit.docId, hit.id, hit.text])).digest('hex');
  return { ref: `[cite:${hash.slice(0, 24)}]`, docId: hit.docId, chunkId: hit.id, score: hit.score };
}

export function retrievalOutput(hits: VectorQueryResult[]): { hits: (VectorQueryResult & { citation: string })[] } {
  return { hits: hits.map(hit => {
    const { filePath, ...meta } = hit.meta ?? {};
    return { ...hit, meta: hit.meta && meta, citation: citationFor(hit).ref };
  }) };
}

export function collectCitations(output: string, steps: Step[], retrieveTool: string): Citation[] {
  const references = new Set(output.match(/\[cite:[a-f0-9]{24}\]/g));
  if (!references.size) return [];

  const citations: Citation[] = [];
  for (const step of steps) {
    if (step.type !== 'tool' || step.name !== retrieveTool || step.source !== 'builtin' || step.error) continue;
    const hits = (step.output as { hits?: unknown } | undefined)?.hits;
    if (!Array.isArray(hits)) continue;
    for (const hit of hits) {
      if (!hit || typeof hit.id !== 'string' || typeof hit.docId !== 'string'
        || typeof hit.text !== 'string' || !Number.isFinite(hit.score)) continue;
      const citation = citationFor(hit);
      if (hit.citation === citation.ref && references.delete(citation.ref)) {
        citations.push(citation);
      }
    }
  }
  return citations;
}
