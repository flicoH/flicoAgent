import { mkdirSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { MemoryStore, ThreadCheckpoint } from '../store.interface';
import { writeJsonAtomically } from './write-json-atomically';

/**
 * 文件型 Memory 存储唯一实现 (FileMemoryStore)
 *
 * 【无状态框架的会话记忆持久化实现】
 * 1. 存储结构：每个 thread 一个独立 JSON 文件：`${threadId}.json`；
 * 2. 原子写入：采用“先写临时文件 (.tmp) + rename 原子替换”的双阶段写入机制；
 * 3. 安全防卫：严格校验 threadId 格式（仅允许字母、数字、连字符、下划线），杜绝路径穿越风险；
 * 4. 容错读取：文件不存在 (ENOENT) 时作为正常未命中返回 null，其他 I/O 错误正常向上抛出；
 * 5. 删除支持：支持 delete(threadId) 清理会话历史文件；
 * 6. 工厂实例化：无 @Injectable() 装饰器，由 StoreModule 工厂根据配置路径实例化。
 */
export class FileMemoryStore implements MemoryStore {
  /**
   * 构造函数
   * @param rootDir 保存 Memory JSON 文件的根目录绝对路径
   */
  constructor(private readonly rootDir: string) {
    try {
      mkdirSync(this.rootDir, { recursive: true });
    } catch {
      // 容错忽略启动时目录已存在
    }
  }

  /**
   * 保存（新增或覆盖）会话检查点
   *
   * @param checkpoint 线程检查点数据
   */
  async save(checkpoint: ThreadCheckpoint): Promise<void> {
    if (!checkpoint || typeof checkpoint.threadId !== 'string') {
      throw new Error('ThreadCheckpoint must have a valid string threadId');
    }
    await writeJsonAtomically(this.filePath(checkpoint.threadId), checkpoint);
  }

  /**
   * 读取指定 threadId 的会话检查点
   *
   * @param threadId 线程标识
   * @returns 匹配的检查点对象，不存在时返回 null
   */
  async load(threadId: string): Promise<ThreadCheckpoint | null> {
    if (!threadId || typeof threadId !== 'string') {
      return null;
    }
    try {
      const content = await readFile(this.filePath(threadId), 'utf8');
      return JSON.parse(content) as ThreadCheckpoint;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * 删除指定 threadId 的会话记录文件
   *
   * @param threadId 线程标识
   */
  async delete(threadId: string): Promise<void> {
    if (!threadId || typeof threadId !== 'string') {
      return;
    }
    try {
      await unlink(this.filePath(threadId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }

  /**
   * 将 threadId 解析为安全的文件路径并进行路径穿越安全校验
   */
  private filePath(threadId: string): string {
    const rawId = typeof threadId === 'string' ? threadId.trim() : '';
    // 去除外层可能的花括号占位符
    const cleanId = decodeURIComponent(rawId).replace(/^\{|\}$/g, '').trim();

    if (!cleanId || !/^[a-zA-Z0-9_\-]+$/.test(cleanId)) {
      throw new Error(`Invalid threadId "${threadId}": must contain only alphanumeric, dash or underscore characters`);
    }

    return join(this.rootDir, `${cleanId}.json`);
  }
}
