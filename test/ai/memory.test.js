const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { FileMemoryStore } = require('../../dist/ai/store/reference/file-memory.store');
const { resolveMemoryPath, resolveMemoryMaxTurns, resolveThreadEnabled } = require('../../dist/ai/memory/internal/load-memory-config');
const { ThreadService } = require('../../dist/ai/memory/thread.service');
const { CheckpointService } = require('../../dist/ai/memory/checkpoint.service');

describe('MemoryStore · Thread · Checkpoint · Orchestrator 接 threadId', () => {
  const tmpDir = path.resolve(__dirname, '../../data/test-memory-' + Date.now());

  before(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('1, 2, 3: FileMemoryStore', () => {
    it('save 和 load 能正确持久化每 thread 一个 JSON 文件并支持 delete', async () => {
      const store = new FileMemoryStore(tmpDir);
      const threadId = 'test-thread-1';
      const checkpoint = {
        threadId,
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi there' },
        ],
        updatedAt: Date.now(),
      };

      await store.save(checkpoint);

      // 验证物理文件写入
      const filePath = path.join(tmpDir, `${threadId}.json`);
      assert.strictEqual(fs.existsSync(filePath), true);
      const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      assert.strictEqual(content.threadId, threadId);
      assert.strictEqual(content.messages.length, 2);

      // 验证 load
      const loaded = await store.load(threadId);
      assert.deepStrictEqual(loaded, checkpoint);

      // 验证不存在的 threadId 返回 null
      const nonExistent = await store.load('non-existent-thread');
      assert.strictEqual(nonExistent, null);

      // 验证 delete
      await store.delete(threadId);
      assert.strictEqual(fs.existsSync(filePath), false);
      const reloaded = await store.load(threadId);
      assert.strictEqual(reloaded, null);
    });

    it('非法路径防卫：杜绝目录穿越', async () => {
      const store = new FileMemoryStore(tmpDir);
      await assert.rejects(
        store.load('../traversal-thread'),
        /Invalid threadId/,
      );
    });
  });

  describe('4: load-memory-config', () => {
    it('resolveMemoryPath 读取 ai.store.memory.path，缺省回退 data/memory', () => {
      const mockConfig1 = {
        get: (key) => key === 'ai' ? { store: { memory: { path: './custom/mem' } } } : undefined,
      };
      assert.strictEqual(
        resolveMemoryPath(mockConfig1),
        path.resolve(process.cwd(), './custom/mem'),
      );

      const mockConfigDefault = {
        get: () => undefined,
      };
      assert.strictEqual(
        resolveMemoryPath(mockConfigDefault),
        path.resolve(process.cwd(), 'data/memory'),
      );
    });

    it('resolveMemoryMaxTurns 读配置，缺省为 20，非法或 <=0 一律回退到 20', () => {
      const mockConfigCustom = {
        get: (key) => key === 'ai' ? { store: { memory: { maxTurns: 10 } } } : undefined,
      };
      assert.strictEqual(resolveMemoryMaxTurns(mockConfigCustom), 10);

      const mockConfigInvalid = {
        get: (key) => key === 'ai' ? { store: { memory: { maxTurns: -5 } } } : undefined,
      };
      assert.strictEqual(resolveMemoryMaxTurns(mockConfigInvalid), 20);

      const mockConfigStringInvalid = {
        get: (key) => key === 'ai' ? { store: { memory: { maxTurns: 'invalid' } } } : undefined,
      };
      assert.strictEqual(resolveMemoryMaxTurns(mockConfigStringInvalid), 20);

      const mockConfigDefault = {
        get: () => undefined,
      };
      assert.strictEqual(resolveMemoryMaxTurns(mockConfigDefault), 20);
    });

    it('resolveThreadEnabled 读取 agentConfig.threadEnabled 并支持 local/beta/prod 覆盖', () => {
      // 缺省返回 true
      assert.strictEqual(resolveThreadEnabled({ get: () => undefined }), true);

      // 读取 agentConfig.threadEnabled = false
      const mockFalse = {
        get: (key) => key === 'agentConfig.threadEnabled' ? false : undefined,
      };
      assert.strictEqual(resolveThreadEnabled(mockFalse), false);

      // 读取 ai.agentConfig.threadEnabled = false
      const mockAiFalse = {
        get: (key) => key === 'ai.agentConfig.threadEnabled' ? false : undefined,
      };
      assert.strictEqual(resolveThreadEnabled(mockAiFalse), false);
    });
  });

  describe('5: ThreadService', () => {
    const configService = {
      get: (key) => key === 'ai' ? { store: { memory: { maxTurns: 4 } } } : undefined,
    };
    const threadService = new ThreadService(configService);

    it('createThread 与 ensureThread 保证线程 ID 不被覆盖且自动创建', () => {
      const newId = threadService.createThread();
      assert.strictEqual(typeof newId, 'string');
      assert.strictEqual(newId.length > 0, true);

      // 已有 id 原样返回
      assert.strictEqual(threadService.ensureThread('existing-thread-123'), 'existing-thread-123');
      // 空值或未传时自动生成新 id
      const autoId = threadService.ensureThread('');
      assert.strictEqual(typeof autoId, 'string');
      assert.notStrictEqual(autoId, '');
    });

    it('buildContextMessages 只提取 user 和 assistant 角色', () => {
      const checkpoint = {
        threadId: 't1',
        messages: [
          { role: 'user', content: 'question 1' },
          { role: 'assistant', content: 'answer 1' },
          { role: 'system', content: 'ignore this' },
        ],
        updatedAt: 1000,
      };
      const context = threadService.buildContextMessages(checkpoint);
      assert.strictEqual(context.length, 2);
      assert.strictEqual(context[0].role, 'user');
      assert.strictEqual(context[0].content, 'question 1');
      assert.strictEqual(context[1].role, 'assistant');
      assert.strictEqual(context[1].content, 'answer 1');
    });

    it('truncate 滑动窗口按消息条数截断，不足时原样返回', () => {
      const messages = [
        { role: 'user', content: 'm1' },
        { role: 'assistant', content: 'm2' },
        { role: 'user', content: 'm3' },
        { role: 'assistant', content: 'm4' },
        { role: 'user', content: 'm5' },
      ];

      // 配置中 maxTurns 为 4，传入 5 条应截断保留最后 4 条
      const truncated = threadService.truncate(messages);
      assert.strictEqual(truncated.length, 4);
      assert.strictEqual(truncated[0].content, 'm2');
      assert.strictEqual(truncated[3].content, 'm5');

      // 指定参数 maxTurns=2
      const truncated2 = threadService.truncate(messages, 2);
      assert.strictEqual(truncated2.length, 2);
      assert.strictEqual(truncated2[0].content, 'm4');
      assert.strictEqual(truncated2[1].content, 'm5');

      // 不足时不截断
      const shortMessages = [{ role: 'user', content: 'm1' }];
      assert.strictEqual(threadService.truncate(shortMessages).length, 1);
    });

    it('appendTurn 追加问答并更新时间戳', () => {
      const initial = {
        threadId: 't1',
        messages: [{ role: 'user', content: 'first' }],
        updatedAt: 1000,
      };
      const updated = threadService.appendTurn(initial, 'second question', 'second answer');
      assert.strictEqual(updated.threadId, 't1');
      assert.strictEqual(updated.messages.length, 3);
      assert.strictEqual(updated.messages[1].content, 'second question');
      assert.strictEqual(updated.messages[2].content, 'second answer');
      assert.strictEqual(updated.updatedAt > 1000, true);

      // 当 checkpoint 为空但传入 fallbackThreadId 时，严格使用传入的 threadId，绝不生成随机 UUID
      const fresh = threadService.appendTurn(null, 'q1', 'a1', 'fixed-thread-id');
      assert.strictEqual(fresh.threadId, 'fixed-thread-id');
      assert.strictEqual(fresh.messages.length, 2);
      assert.strictEqual(fresh.messages[0].content, 'q1');
      assert.strictEqual(fresh.messages[1].content, 'a1');
    });
  });

  describe('6: CheckpointService', () => {
    it('只 persist 对话 turns，严格过滤 steps', async () => {
      const memoryStore = new FileMemoryStore(tmpDir);
      const checkpointService = new CheckpointService(memoryStore);

      const dirtyCheckpoint = {
        threadId: 'checkpoint-test-1',
        messages: [
          { role: 'user', content: 'what is jd?' },
          { role: 'assistant', content: 'jd is a project.' },
          { role: 'tool', content: 'should be stripped' },
        ],
        steps: [
          { type: 'plan', iteration: 1 },
        ],
        updatedAt: 2000,
      };

      await checkpointService.save(dirtyCheckpoint);
      const loaded = await checkpointService.load('checkpoint-test-1');
      assert.strictEqual(loaded.threadId, 'checkpoint-test-1');
      // 只有 user 和 assistant 两个 turns
      assert.strictEqual(loaded.messages.length, 2);
      assert.strictEqual(loaded.messages[0].role, 'user');
      assert.strictEqual(loaded.messages[1].role, 'assistant');
      assert.strictEqual(loaded.steps, undefined);
    });
  });
});
