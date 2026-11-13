import { addTokenUsage } from '../runtime/internal/token-usage';
import { Inject, Injectable, NotImplementedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SerialByKey } from '../../common/async/serial-by-key';
import { TRACE_STORE, TraceListQuery, TraceStore } from '../store/store.interface';
import { Step, TraceRun } from '../contracts';

/**
 * 运行链路追踪服务 (TraceService)
 *
 * 【追踪职责】
 * TraceService 记录运行期间的事实，不决定 Planner 或 Executor 的分支。
 * 编排器会等待持久化完成，因此存储错误仍会中断当前运行：
 * 1. 初始化运行实例并分配全局唯一 runId (UUID)；
 * 2. 在每个 ReAct 阶段（plan、skill/tool 执行、observe 观察、final 产出）按时间序追加 Step；
 * 3. 当检测到 final 步骤时同步更新运行级别的 output 字段；
 * 4. 提供 Trace 检索接口供前端或审计端点回放链路。
 */
@Injectable()
export class TraceService {
  private readonly writes = new SerialByKey();
  /**
   * 构造函数注入抽象存储合同 TraceStore
   * @param store 追踪存储实现
   */
  constructor(@Inject(TRACE_STORE) private readonly store: TraceStore) {}

  /**
   * 创建初始运行记录并立即持久化
   *
   * @param agent 执行本次任务的 Agent 注册名称
   * @param input 调用方传入的初始入参
   * @param threadId 可选会话线程 ID
   * @param scope 调用方的资源命名空间，供运行查询和管理接口校验归属
   * @param metadata 初始运行状态、工作实例标识及父子运行关系
   * @returns 初始化的 TraceRun 对象
   */
  async createRun(agent: string, input: unknown, threadId?: string, scope?: string,
    metadata: Pick<TraceRun, 'status' | 'parentRunId' | 'rootRunId' | 'workerId'> = {},
  ): Promise<TraceRun> {
    const now = new Date().toISOString();
    const run: TraceRun = {
      ...metadata,
      runId: randomUUID(),
      agent,
      input,
      output: '',
      steps: [],
      threadId: threadId ?? '',
      ...(scope ? { scope } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await this.store.save(run);
    return run;
  }

  /**
   * 向指定运行追加一个执行步骤
   *
   * @param runId 目标运行 ID
   * @param step 待追加的步骤记录
   * @returns 更新后的 TraceRun 对象
   */
  async addStep(runId: string, step: Step): Promise<TraceRun> {
    return this.update(runId, run => {
      if (run.status === 'cancelled') return false;
      run.steps.push(step);
      // 同一模型调用即使返回多条工具指令也只累计一次。
      if (step.usage) run.usage = addTokenUsage(run.usage, step.usage);
      if (step.modelDurationMs !== undefined) {
        run.modelDurationMs = (run.modelDurationMs ?? 0) + step.modelDurationMs;
      }
      if ((step.type === 'final' || step.type === 'guardrail') && typeof step.output === 'string') {
        run.output = step.output;
      }
    });
  }

  /**
   * 使用 runId 作为写锁键，串行完成加载、变更和保存。
   * 状态检查与步骤追加都基于锁内读取的最新版本，避免审批、取消和执行相互覆盖。
   * 回调返回 false 时保留原记录，例如重复取消时可以直接复用已提交的结果。
   */
  update(runId: string, change: (run: TraceRun) => void | false | Promise<void | false>): Promise<TraceRun> {
    return this.writes.run(runId, async () => {
      const run = await this.store.load(runId);
      if (!run) throw new Error(`Trace run "${runId}" does not exist`);
      if (await change(run) !== false) {
        run.updatedAt = new Date().toISOString();
        await this.store.save(run);
      }
      return run;
    });
  }

  /** 列表由 Store 先按 scope 和 Agent 过滤再分页，单条读写仍可沿用旧版 Store。 */
  list(query: TraceListQuery): Promise<TraceRun[]> {
    if (!this.store.list) throw new NotImplementedException('Trace store does not support listing');
    return this.store.list(query);
  }

  /**
   * 读取指定 runId 的完整运行链路追踪数据
   *
   * @param runId 运行 ID
   * @returns 完整的 TraceRun，若不存在则返回 null
   */
  load(runId: string): Promise<TraceRun | null> {
    return this.store.load(runId);
  }
}
