const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { FileVectorStore } = require('../../dist/ai/store/reference/file-vector.store');
const { RetrieverService } = require('../../dist/ai/rag/retriever.service');
const { collectCitations, retrievalOutput } = require('../../dist/ai/rag/citations');

describe('LLM Wiki 增量索引与检索', () => {
  let fixture;
  let mode;
  let invalid;
  let blocked;
  let calls;
  let documents;
  let config;
  let source;
  let service;
  let index;

  beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), 'flico-wiki-test-'));
    index = join(fixture, 'vectors.json');
    mode = 'hybrid';
    invalid = false;
    blocked = false;
    calls = [];
    documents = new Map([
      ['guide.md', '  退款有效期为三十天。😀  '],
      ['faq.md', '发票仍需单独提交。'],
      ['appeal.md', '可请求人工复核。'],
    ]);
    source = {
      key: 'mysql:wiki-tests', meta: { source: 'mysql', collection: 'wiki-tests' },
      documents: async () => [...documents].sort().map(([docId, text]) => ({ docId, read: async () => text })),
    };
    config = { get: key => ({
      'ai.rag': { mode, wiki: { model: 'wiki' } },
      'ai.embedding': { use: { async embed(texts) {
        if (blocked && texts.includes(documents.get('guide.md')?.trim())) throw new Error('Embedding unavailable');
        return texts.map(() => [1, 0]);
      } } },
      'ai.llm': { default: 'wiki', models: { wiki: { use: { async chat(messages) {
        const { chunks, catalog } = JSON.parse(messages.at(-1).content);
        const [chunk] = chunks;
        calls.push({ docId: chunk.docId, catalog });
        const appeal = chunk.docId === 'appeal.md';
        return { output: JSON.stringify({ sections: [{
          pageId: appeal ? 'appeals' : 'refunds', title: appeal ? '人工复核' : '退款规则', heading: chunk.docId,
          markdown: '**知识摘要**\n\n' + chunk.text, chunkIds: [invalid ? 'invented' : chunk.id],
          links: appeal ? ['refunds', 'missing-page'] : ['appeals'],
        }] }) };
      } } } } },
    })[key] };
    service = new RetrieverService(new FileVectorStore(index), config, source);
  });

  afterEach(async () => { await rm(fixture, { recursive: true, force: true }); });

  it('组合多个文档的主题页，增量重编后按版本定位，并在删除后清理依赖和页面链接', async () => {
    const first = await service.rebuild();
    assert.deepEqual(first.wiki, { pages: 2, sections: 3, generatedSections: 3 });
    assert.ok(calls.find(call => call.docId === 'guide.md').catalog.some(page => page.pageId === 'refunds'));
    assert.deepEqual(await service.listDocuments(), [
      { docId: 'appeal.md', chunks: 1 }, { docId: 'faq.md', chunks: 1 }, { docId: 'guide.md', chunks: 1 },
    ]);
    const restarted = new RetrieverService(new FileVectorStore(index), config, source);
    assert.deepEqual(await restarted.listWikiPages(), [
      { id: 'appeals', title: '人工复核', sections: 1 }, { id: 'refunds', title: '退款规则', sections: 2 },
    ]);
    const page = await restarted.loadWikiPage('refunds');
    assert.match(page.markdown, /^# 退款规则/);
    assert.match(page.markdown, /人工复核.*page\?id=appeals/);
    assert.deepEqual((await restarted.loadWikiPage('appeals')).links.map(link => link.id), ['refunds']);
    const guide = page.sections.find(section => section.heading === 'guide.md');
    const [reference] = guide.sources;
    assert.equal(documents.get('guide.md').slice(reference.start, reference.end), reference.text);
    const raw = await restarted.loadChunk(undefined, reference.chunkId);
    assert.equal(reference.version, raw.meta.version);
    assert.equal(reference.text, raw.text);
    assert.equal(reference.collection, 'wiki-tests');

    calls.length = 0;
    assert.equal((await restarted.rebuild()).wiki.generatedSections, 0);
    assert.deepEqual(calls, []);
    documents.set('guide.md', '  退款有效期改为十五天。  ');
    const update = await restarted.rebuild();
    assert.equal(update.wiki.generatedSections, 1);
    assert.deepEqual(calls.map(call => call.docId), ['guide.md']);
    assert.equal(await restarted.loadChunk(undefined, guide.chunkId), null);
    assert.equal(await restarted.loadChunk(undefined, reference.chunkId), null);
    const next = await restarted.loadWikiPage('refunds');
    assert.match(next.markdown, /十五天/);
    assert.equal(next.sections.find(section => section.heading === 'faq.md').chunkId,
      page.sections.find(section => section.heading === 'faq.md').chunkId);

    const appeal = await restarted.loadWikiPage('appeals');
    assert.equal(await restarted.deleteDocument(undefined, 'appeal.md'), 1);
    assert.equal(await restarted.loadWikiPage('appeals'), null);
    assert.equal(await restarted.loadChunk(undefined, appeal.sections[0].chunkId), null);
    assert.deepEqual((await restarted.loadWikiPage('refunds')).links, []);
    documents.delete('guide.md');
    await restarted.rebuild();
    const remaining = await restarted.loadWikiPage('refunds');
    assert.deepEqual(remaining.sections.map(section => section.heading), ['faq.md']);
  });

  it('隔离 RAG 和 Wiki TopK，混合排名共享可引用的证据且只收录答案标记', async () => {
    await service.rebuild();
    mode = 'rag';
    const raw = (await service.preview(undefined, '退款', 2)).hits;
    assert.equal(raw.length, 2);
    assert.ok(raw.every(hit => !hit.meta.wiki));
    mode = 'wiki';
    const wiki = (await service.preview(undefined, '退款', 2)).hits;
    assert.equal(wiki.length, 2);
    assert.ok(wiki.every(hit => hit.meta.kind === 'wiki'));
    mode = 'hybrid';
    const hits = (await service.preview(undefined, '退款', 2)).hits;
    assert.deepEqual(new Set(hits.map(hit => hit.meta.kind ?? 'rag')), new Set(['rag', 'wiki']));
    const observed = retrievalOutput(hits);
    const [used, unused] = [observed.hits.find(hit => hit.meta.kind === 'wiki'), observed.hits.find(hit => !hit.meta.kind)];
    const citations = collectCitations('根据主题页 ' + used.citation + '。示例：\x60' + unused.citation + '\x60', [
      { type: 'tool', name: 'retrieve', source: 'builtin', output: observed },
    ], 'retrieve');
    assert.deepEqual(citations, [{
      ref: used.citation, docId: used.docId, chunkId: used.id, score: used.score,
      kind: 'wiki', pageId: used.meta.wiki.pageId,
    }]);
    assert.equal(used.meta.wiki.ownerDocId, undefined);
    assert.ok(used.meta.wiki.sources[0].text);
  });

  it('无效的生成来源使重建整体回滚，单文档向量化失败保留原文和 Wiki', async () => {
    await service.rebuild();
    const page = await service.loadWikiPage('refunds');
    const guide = page.sections.find(section => section.heading === 'guide.md');
    documents.set('guide.md', '取消退款时限。');
    invalid = true;
    await assert.rejects(service.rebuild(), /must reference source chunks/);
    assert.deepEqual(await service.loadWikiPage('refunds'), page);
    assert.ok(await service.loadChunk(undefined, guide.sources[0].chunkId));

    invalid = false;
    blocked = true;
    const retry = await service.rebuild();
    assert.deepEqual(retry.failed, [{ docId: 'guide.md', stage: 'embed' }]);
    assert.equal(retry.wiki.generatedSections, 0);
    assert.deepEqual(await service.loadWikiPage('refunds'), page);
  });

  it('文档缩短或清空使失效 Wiki 段落退出检索，删除后重建恢复页面与链接', async () => {
    const chunkedConfig = { get: key => ({
      'ai.rag': { mode: 'wiki', chunk: { size: 12, overlap: 0 } },
      'ai.embedding': config.get('ai.embedding'),
      'ai.llm': { default: 'wiki', models: { wiki: { use: { async chat(messages) {
        const { chunks } = JSON.parse(messages.at(-1).content);
        calls.push({ docId: chunks[0].docId, count: chunks.length });
        const appeal = chunks[0].docId === 'appeal.md';
        return { output: '```json ' + JSON.stringify({ sections: [{
          pageId: appeal ? 'appeals' : 'refunds', title: appeal ? '人工复核' : '退款规则',
          heading: chunks[0].docId, markdown: chunks.map(c => c.text).join('\n'),
          chunkIds: chunks.map(c => c.id), links: appeal ? ['refunds'] : ['appeals'],
        }] }) + '```' };
      } } } } },
    })[key] };
    const wikiService = new RetrieverService(new FileVectorStore(index), chunkedConfig, source);
    documents.set('guide.md', '第一段退款规则说明。第二段补充条款说明。第三段额外附注。');
    await wikiService.rebuild();
    const initial = await wikiService.loadWikiPage('refunds');
    const guideBefore = initial.sections.find(s => s.heading === 'guide.md');
    assert.ok(guideBefore.sources.length >= 2);
    const oldRawIds = guideBefore.sources.map(s => s.chunkId);

    // 缩短文档：旧原文切片与旧 Wiki 段落均退出检索
    documents.set('guide.md', '仅保留十天。');
    await wikiService.rebuild();
    assert.equal(await wikiService.loadChunk(undefined, guideBefore.chunkId), null);
    for (const rawId of oldRawIds) assert.equal(await wikiService.loadChunk(undefined, rawId), null);
    const shortened = await wikiService.loadWikiPage('refunds');
    const guideAfter = shortened.sections.find(s => s.heading === 'guide.md');
    assert.equal(guideAfter.sources.length, 1);
    assert.match(shortened.markdown, /仅保留十天/);

    // 缩短为空白：跳过该文档并从 Wiki 移除其段落
    documents.set('guide.md', '   \n ');
    const emptied = await wikiService.rebuild();
    assert.deepEqual(emptied.skipped, ['guide.md']);
    assert.equal(await wikiService.loadChunk(undefined, guideAfter.chunkId), null);
    assert.deepEqual((await wikiService.loadWikiPage('refunds')).sections.map(s => s.heading), ['faq.md']);

    // 删除索引后重建：源文件仍在时恢复文档及其 Wiki 页面和互相链接
    const removedDocs = await wikiService.deleteDocument(undefined, 'appeal.md');
    assert.equal(removedDocs, 1);
    assert.equal(await wikiService.loadWikiPage('appeals'), null);
    assert.deepEqual((await wikiService.loadWikiPage('refunds')).links, []);
    calls.length = 0;
    const restored = await wikiService.rebuild();
    assert.equal(restored.wiki.generatedSections, 1);
    assert.deepEqual(calls.map(c => c.docId), ['appeal.md']);
    assert.deepEqual((await wikiService.loadWikiPage('refunds')).links.map(l => l.id), ['appeals']);
    assert.deepEqual((await wikiService.loadWikiPage('appeals')).links.map(l => l.id), ['refunds']);

    // 暂时移除源文档后重建再加回源文件：恢复页面链接
    const savedAppeal = documents.get('appeal.md');
    documents.delete('appeal.md');
    await wikiService.rebuild();
    assert.equal(await wikiService.loadWikiPage('appeals'), null);
    assert.deepEqual((await wikiService.loadWikiPage('refunds')).links, []);
    documents.set('appeal.md', savedAppeal);
    await wikiService.rebuild();
    assert.deepEqual((await wikiService.loadWikiPage('refunds')).links.map(l => l.id), ['appeals']);
  });

  it('重建期间可读旧 Wiki 索引，外链/Wiki 向量化失败回滚并支持无 queryHybrid 的混合检索', async () => {
    await service.rebuild();
    const oldPage = await service.loadWikiPage('refunds');
    const oldSectionId = oldPage.sections.find(s => s.heading === 'guide.md').chunkId;
    let release;
    let entered;
    const gate = new Promise(r => { release = r; });
    const enteredPromise = new Promise(r => { entered = r; });
    let failWikiEmbed = false;

    const slowConfig = { get: key => ({
      'ai.rag': { mode: 'hybrid', topK: 2, wiki: { model: 'wiki' } },
      'ai.embedding': { use: { async embed(texts) {
        if (failWikiEmbed && texts.some(t => t.includes('**知识摘要**') && t.includes('七天'))) {
          throw new Error('Wiki embedding failed');
        }
        return texts.map(() => [1, 0]);
      } } },
      'ai.llm': { default: 'wiki', models: { wiki: { use: { async chat(messages) {
        const [chunk] = JSON.parse(messages.at(-1).content).chunks;
        if (chunk.docId === 'guide.md') {
          entered();
          await gate;
        }
        return { output: JSON.stringify({ sections: [{
          pageId: 'refunds', title: '退款规则', heading: chunk.docId,
          markdown: '**知识摘要**\n\n' + chunk.text,
          chunkIds: [chunk.id],
        }] }) };
      } } } } },
    })[key] };

    const slowService = new RetrieverService(new FileVectorStore(index), slowConfig, source);
    documents.set('guide.md', '七天无理由退货。');
    const pending = slowService.rebuild();
    await enteredPromise;

    // 重建期间：预览、Wiki 页面和切片定位仍命中旧版索引
    try {
      const duringHits = (await slowService.preview(undefined, '退款', 6)).hits;
      assert.ok(duringHits.some(h => h.id === oldSectionId));
      assert.deepEqual(await slowService.loadWikiPage('refunds'), oldPage);
      assert.ok(await slowService.loadChunk(undefined, oldSectionId));
    } finally {
      failWikiEmbed = true;
      release();
    }
    await assert.rejects(pending, /Wiki embedding failed/);
    assert.deepEqual(await slowService.loadWikiPage('refunds'), oldPage);

    // LLM 返回内嵌链接 Markdown 时发布前校验失败并保留旧索引
    failWikiEmbed = false;
    const directConfig = { get: key => key === 'ai.llm'
      ? { default: 'wiki', models: { wiki: { use: { async chat(messages) {
        const [chunk] = JSON.parse(messages.at(-1).content).chunks;
        return { output: JSON.stringify({ sections: [{
          pageId: 'refunds', title: '退款规则', heading: chunk.docId,
          markdown: '[非法链接](https://example.com)', chunkIds: [chunk.id],
        }] }) };
      } } } } }
      : slowConfig.get(key) };
    await assert.rejects(
      new RetrieverService(new FileVectorStore(index), directConfig, source).rebuild(),
      /structured page links/,
    );
    assert.deepEqual(await slowService.loadWikiPage('refunds'), oldPage);

    // 自定义 VectorStore 无 queryHybrid 时，hybrid 模式走独立两路 query + RRF 融合
    const fileStore = new FileVectorStore(index);
    const basicStore = {
      upsert: r => fileStore.upsert(r),
      query: (e, k, r, kind) => fileStore.query(e, k, r, kind),
      wikiChunks: r => fileStore.wikiChunks(r),
    };
    const basicService = new RetrieverService(basicStore, config, source);
    mode = 'hybrid';
    const fused = (await basicService.preview(undefined, '退款', 2)).hits;
    assert.deepEqual(new Set(fused.map(h => h.meta.kind ?? 'rag')), new Set(['rag', 'wiki']));
  });
});
