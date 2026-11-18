import type { TraceRun } from '../contracts';

/**
 * TraceStore 依赖注入标识 (Token)
 *
 * 【接口与实现解耦】
 * Runtime 与 TraceService 仅依赖 TRACE_STORE 符号 Token 注入的抽象接口，
 * 框架底层或业务 demo 可自由替换为文件存储、SQLite、Redis 或远程对象存储，而无需修改上层逻辑。
 */
export const TRACE_STORE = Symbol('TRACE_STORE');

/**
 * 运行链路追踪存储契约 (TraceStore)
 *
 * 【跨请求与跨重启持久化】
 * 负责保存与读取 Agent 的全量运行轨迹（包含 runId、输入参数、执行轮次步骤、最终回答等）。
 */
export interface TraceStore {
  /**
   * 保存（新增或覆盖）一条运行记录
   *
   * @param run 完整的 TraceRun 实体
   */
  save(run: TraceRun): Promise<void>;

  /**
   * 根据 runId 检索历史运行记录
   *
   * @param runId 运行唯一标识符
   * @returns 匹配的 TraceRun 记录，未找到时返回 null
   */
  load(runId: string): Promise<TraceRun | null>;
}

/**
 * 记忆消息条目契约
 */
export interface MemoryEntry {
  /** 消息所属角色：仅记录用户提问与助手最终答复 */
  role: 'user' | 'assistant';
  /** 消息正文文本 */
  content: string;
}

/**
 * 线程会话检查点契约 (ThreadCheckpoint)
 *
 * 【轻量持久化设计】
 * 仅保存多轮对话历史消息 turns，不存储中间复杂工具调用与观察步骤 (steps)
 */
export interface ThreadCheckpoint {
  /** 线程会话全局唯一标识符 (UUID) */
  threadId: string;
  /** 历史对话消息序列 */
  messages: MemoryEntry[];
  /** 最近更新时间毫秒戳 (Date.now()) */
  updatedAt: number;
}

/**
 * MemoryStore 依赖注入标识 (Token)
 */
export const MEMORY_STORE = Symbol('MEMORY_STORE');

/**
 * 会话上下文与长期记忆存储契约 (MemoryStore)
 *
 * 【跨请求会话持久化】
 * 负责保存、读取与删除 Thread 的多轮对话检查点
 */
export interface MemoryStore {
  /**
   * 保存（新增或覆盖）指定线程的检查点
   *
   * @param checkpoint 线程检查点数据
   */
  save(checkpoint: ThreadCheckpoint): Promise<void>;

  /**
   * 根据 threadId 读取历史会话检查点
   *
   * @param threadId 线程标识
   * @returns 匹配的检查点数据，未找到时返回 null
   */
  load(threadId: string): Promise<ThreadCheckpoint | null>;

  /**
   * 删除指定线程的会话历史记录
   *
   * @param threadId 线程标识
   */
  delete?(threadId: string): Promise<void>;
}

/**
 * 向量存储依赖注入标识 (Token)
 */
export const VECTOR_STORE = Symbol('VECTOR_STORE');

/**
 * 单条向量记录契约
 */
export interface VectorRecord {
  /** 唯一分块 ID */
  id: string;
  /** 所属文档或文件唯一标识 */
  docId: string;
  /** 分块文本原始内容 */
  text: string;
  /** 计算得到的高维向量数据 */
  embedding: number[];
  /** 自定义元数据（如文件路径、标题、分块位置等） */
  meta?: Record<string, unknown>;
}

/**
 * 向量检索命中结果契约
 */
export interface VectorQueryResult {
  /** 分块唯一 ID */
  id: string;
  /** 所属文档唯一标识 */
  docId: string;
  /** 命中分块文本内容 */
  text: string;
  /** 语义相似度得分（例如余弦相似度，值域通常在 -1 到 1 或 0 到 1） */
  score: number;
  /** 携带的自定义元数据 */
  meta?: Record<string, unknown>;
}

/**
 * 向量索引存储契约 (VectorStore)
 *
 * 【跨请求持久化】
 * 统一管理文档切片的高维向量与元数据存储，支撑 RAG 近邻相似度查询。
 */
export interface VectorStore {
  /**
   * 批量写入或更新向量切片记录
   *
   * @param records 待持久化的向量记录数组
   */
  upsert(records: VectorRecord[]): Promise<void>;

  /**
   * 根据查询向量检索 TopK 相似片段
   *
   * @param embedding 查询语句的目标高维向量
   * @param topK 返回的最相似结果条数
   * @returns 匹配的向量结果切片列表（按 score 降序排列）
   */
  query(embedding: number[], topK: number): Promise<VectorQueryResult[]>;
}
