import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TRACE_STORE, TraceStore } from '../store/store.interface';
import { Step, TraceRun } from '../runtime/runtime.types';

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
   * @returns 初始化的 TraceRun 对象
   */
  async createRun(agent: string, input: unknown, threadId?: string): Promise<TraceRun> {
    const now = new Date().toISOString();
    const run: TraceRun = {
      runId: randomUUID(),
      agent,
      input,
      output: '',
      steps: [],
      threadId: threadId ?? '',
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
    // 采用读取、修改、保存方式追加；同一 runId 的并发追加需要存储层或调用方协调。
    const run = await this.store.load(runId);
    if (!run) {
      throw new Error(`Trace run "${runId}" does not exist`);
    }

    run.steps.push(step);
    // 当该步骤为最终完成步骤或安全拦截步骤且包含文本输出时，同步更新顶层 output 字段
    if ((step.type === 'final' || step.type === 'guardrail') && typeof step.output === 'string') {
      run.output = step.output;
    }
    run.updatedAt = new Date().toISOString();
    await this.store.save(run);
    return run;
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
