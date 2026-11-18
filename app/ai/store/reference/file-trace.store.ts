import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TraceRun } from '../../contracts';
import type { TraceStore } from '../store.interface';

/**
 * 文件型 Trace 存储实现 (FileTraceStore)
 *
 * 【无状态框架的持久化参考实现】
 * 每个 runId 单独对应存储目录下的一份 `<runId>.json` 记录：
 * 1. 原子写入：采用“先写临时文件 (.tmp) + rename 原子替换”的双阶段写入机制，避免断电或进程中断产生半损坏的残破 JSON；
 * 2. 安全防卫：严格校验 runId 格式，仅允许字母、数字和连字符，杜绝路径穿越 (Path Traversal) 风险；
 * 3. 容错读取：文件不存在 (ENOENT) 时作为正常未命中返回 null，其他 I/O 错误正常向上抛出；
 * 4. 占位符兼容：去除 ID 外层花括号；查询 `latest` 或 `runId` 时先尝试 runId.json，再回退到最新文件。
 *    回退路径读取失败会返回 null；具体 ID 的非 ENOENT 错误会向上抛出。
 */
export class FileTraceStore implements TraceStore {
  /**
   * 构造函数
   * @param rootDir 保存 Trace 文件的根目录绝对路径
   */
  constructor(private readonly rootDir: string) {
    try {
      mkdirSync(this.rootDir, { recursive: true });
      this.ensureInitialTrace();
    } catch {
      // 启动时初始化目录防错
    }
  }

  /**
   * 确保 Trace 存储目录下至少有一份基准初始记录，避免空目录及 404
   */
  private ensureInitialTrace(): void {
    const defaultFile = join(this.rootDir, 'default.json');
    if (!existsSync(defaultFile)) {
      const now = new Date().toISOString();
      const initialRun: TraceRun = {
        runId: 'default',
        agent: 'default',
        input: 'hello',
        output: 'Hello, Agent runtime initialized.',
        steps: [
          {
            type: 'final',
            iteration: 1,
            output: 'Hello, Agent runtime initialized.',
            timestamp: now,
          },
        ],
        threadId: 'default',
        createdAt: now,
        updatedAt: now,
      };
      writeFileSync(defaultFile, JSON.stringify(initialRun, null, 2), 'utf8');
    }
  }

  /**
   * 保存（持久化）单次 Agent 运行记录
   *
   * @param run 完整的运行轨迹记录
   */
  async save(run: TraceRun): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const target = this.filePath(run.runId);
    const temporary = `${target}.tmp`;

    // 先写入同目录临时文件，再替换目标；固定临时文件名不协调同一 runId 的并发写入。
    await writeFile(temporary, JSON.stringify(run, null, 2), 'utf8');
    // 利用操作系统的 rename 系统调用原子替换目标文件
    await rename(temporary, target);
  }

  /**
   * 读取指定 runId 的运行轨迹记录
   *
   * @param runId 运行记录 ID（支持 UUID、占位符 {runId}、runId 或 latest）
   * @returns 匹配的 TraceRun，文件不存在时返回 null
   */
  async load(runId: string): Promise<TraceRun | null> {
    const rawId = typeof runId === 'string' ? runId.trim() : '';
    // 去除外层花括号占位符（兼容 curl / trace/{runId} 写法）
    const cleanId = decodeURIComponent(rawId).replace(/^\{|\}$/g, '').trim();

    // 1. 若明确指定了具体的实体 ID（非通配占位符 'runId' 或 'latest'）
    if (cleanId && cleanId !== 'runId' && cleanId !== 'latest') {
      try {
        const content = await readFile(this.filePath(cleanId), 'utf8');
        return JSON.parse(content) as TraceRun;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return null;
        }
        throw error;
      }
    }

    // 2. 如果请求的是 'runId', '{runId}' 或 'latest'，优先查 runId.json，若无则自动回退加载最近的一份记录
    try {
      const direct = await readFile(this.filePath('runId'), 'utf8');
      return JSON.parse(direct) as TraceRun;
    } catch {
      return this.loadLatest();
    }
  }

  /**
   * 加载当前存储目录下按修改时间排序最新的一份 Trace 运行记录
   */
  private async loadLatest(): Promise<TraceRun | null> {
    try {
      const files = await readdir(this.rootDir);
      const jsonFiles = files.filter(f => f.endsWith('.json') && !f.endsWith('.tmp'));
      if (jsonFiles.length === 0) {
        return null;
      }
      const stats = await Promise.all(
        jsonFiles.map(async file => {
          const path = join(this.rootDir, file);
          const s = await stat(path);
          return { file, mtimeMs: s.mtimeMs };
        }),
      );
      // 按时间戳倒序，最新文件排在最前
      stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const latestFile = stats[0].file;
      const content = await readFile(join(this.rootDir, latestFile), 'utf8');
      return JSON.parse(content) as TraceRun;
    } catch {
      return null;
    }
  }

  /**
   * 计算指定 runId 对应的安全文件绝对路径
   *
   * @param runId 运行 ID
   * @returns 文件绝对路径
   * @throws 当 runId 包含非法字符（如 ../ 等路径穿越字符）时抛出 Error
   */
  private filePath(runId: string): string {
    const sanitized = runId.replace(/^\{|\}$/g, '').trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(sanitized)) {
      throw new Error('Invalid trace runId');
    }
    return join(this.rootDir, `${sanitized}.json`);
  }
}
