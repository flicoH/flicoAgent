import { createHash } from 'node:crypto';
import MarkdownIt from 'markdown-it';
import type { Citation, Step } from '../contracts';
import type { IndexedChunk, VectorQueryResult } from '../store/store.interface';
import type { WikiSourceReference } from './wiki';

const markdown = new MarkdownIt({ html: true });
const marker = /\[cite:[a-f0-9]{24}\]/y;

// Treat a citation as its own inline token. Markdown consumes code, escapes,
// link destinations and HTML comments before their contents can become tokens.
markdown.inline.ruler.before('link', 'rag_citation', (state, silent) => {
  marker.lastIndex = state.pos;
  const match = marker.exec(state.src);
  if (!match || marker.lastIndex > state.posMax) return false;
  if (!silent) state.push('rag_citation', '', 0).content = match[0];
  state.pos = marker.lastIndex;
  return true;
});

function referenceFor(hit: IndexedChunk): string {
  const hash = createHash('sha256').update(JSON.stringify([hit.docId, hit.id, hit.text])).digest('hex');
  return `[cite:${hash.slice(0, 24)}]`;
}

export function citationChunk(hit: IndexedChunk) {
  const { id, docId, text } = hit;
  const { filePath, root, wiki, ...meta } = hit.meta ?? {};
  const section = wiki as { pageId: string; title: string; heading: string; sources: WikiSourceReference[] } | undefined;
  const publicWiki = meta.kind === 'wiki' && section
    ? { pageId: section.pageId, title: section.title, heading: section.heading, sources: section.sources }
    : undefined;
  return { id, docId, text, meta: { ...meta, ...(publicWiki ? { wiki: publicWiki } : {}), relativePath: docId }, citation: referenceFor(hit) };
}

export function retrievalOutput(hits: VectorQueryResult[]) {
  return { hits: hits.map(hit => ({ ...citationChunk(hit), score: hit.score })) };
}

function bodyReferences(output: string): string[] {
  const refs = new Set<string>();
  for (const block of markdown.parse(output, {})) {
    let literalTag: string | undefined;
    for (const token of block.children ?? []) {
      if (token.type === 'html_inline') {
        const tag = /^<(\/?)(code|kbd|samp|pre)(?:\s|\/?>)/i.exec(token.content);
        if (tag) {
          const name = tag[2].toLowerCase();
          if (tag[1] && literalTag === name) literalTag = undefined;
          if (!tag[1]) literalTag ??= name;
        }
      } else if (token.type === 'rag_citation' && literalTag === undefined) {
        refs.add(token.content);
      }
    }
  }
  return [...refs];
}

export function collectCitations(output: string, steps: Step[], retrieveTool: string): Citation[] {
  if (!output.includes('[cite:')) return [];
  const available = new Map<string, Citation>();
  for (const step of steps) {
    if (step.type !== 'tool' || step.name !== retrieveTool || step.source !== 'builtin' || step.error) continue;
    const hits = (step.output as { hits?: unknown } | undefined)?.hits;
    if (!Array.isArray(hits)) continue;
    for (const hit of hits) {
      if (!hit || typeof hit.id !== 'string' || typeof hit.docId !== 'string'
        || typeof hit.text !== 'string' || !Number.isFinite(hit.score)) continue;
      const ref = referenceFor(hit);
      if (hit.citation === ref && !available.has(ref)) {
        const pageId = hit.meta?.kind === 'wiki' ? hit.meta?.wiki?.pageId : undefined;
        available.set(ref, {
          ref, docId: hit.docId, chunkId: hit.id, score: hit.score,
          ...(typeof pageId === 'string' ? { kind: 'wiki' as const, pageId } : {}),
        });
      }
    }
  }
  return available.size ? bodyReferences(output).flatMap(ref => available.get(ref) ?? []) : [];
}
