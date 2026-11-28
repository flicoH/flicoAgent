import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TRACE_STORE, TraceListQuery, TraceStore } from '../store/store.interface';
import { Step, TraceRun } from '../contracts';
import { summarizeTokenUsage } from './token-usage';

type TraceLineage = Pick<TraceRun, 'parentRunId' | 'rootRunId' | 'delegationDepth' | 'scope'>;

function summarizeModelDuration(steps: Step[], existing = 0): number | undefined {
  let total = 0;
  let hasDuration = false;
  for (const step of steps) {
    if (typeof step.modelDurationMs === 'number' && Number.isFinite(step.modelDurationMs) && step.modelDurationMs >= 0) {
      total += Math.round(step.modelDurationMs);
      hasDuration = true;
    }
  }
  if (hasDuration) return total;
  return existing > 0 ? existing : undefined;
}

/**
 * 运行链路追踪服务 (TraceService)
 *
 * 【追踪职责】
 * TraceService 记录运行期间的事实，按 runId 串行化持久化更新，
 * 避免状态转移与步骤追加并发覆盖。
 */
@Injectable()
export class TraceService {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(@Inject(TRACE_STORE) private readonly store: TraceStore) {}

  async createRun(
    agent: string,
    input: unknown,
    threadId?: string,
    lineageOrScope?: TraceLineage | string,
    initial?: Partial<TraceRun>,
  ): Promise<TraceRun> {
    const lineage: TraceLineage = typeof lineageOrScope === 'string'
      ? { scope: lineageOrScope }
      : (lineageOrScope ?? {});
    const now = new Date().toISOString();
    const run: TraceRun = {
      ...lineage,
      ...initial,
      runId: initial?.runId ?? randomUUID(),
      agent,
      input,
      output: initial?.output ?? '',
      steps: initial?.steps ? [...initial.steps] : [],
      threadId: threadId ?? initial?.threadId ?? '',
      createdAt: initial?.createdAt ?? now,
      updatedAt: initial?.updatedAt ?? now,
    };
    await this.serialize(run.runId, () => this.store.save(run));
    return run;
  }

  async addStep(runId: string, step: Step): Promise<TraceRun> {
    return this.serialize(runId, async () => {
      const run = await this.store.load(runId);
      if (!run) {
        throw new Error(`Trace run "${runId}" does not exist`);
      }

      run.steps.push(step);
      if (step.usage) {
        run.usage = summarizeTokenUsage(run.steps);
      }
      const duration = summarizeModelDuration(run.steps, run.modelDurationMs ?? 0);
      if (duration !== undefined) {
        run.modelDurationMs = duration;
      }
      if ((step.type === 'final' || step.type === 'guardrail') && typeof step.output === 'string') {
        run.output = step.output;
        if (step.citations?.length) run.citations = step.citations;
        else delete run.citations;
      }
      run.updatedAt = new Date().toISOString();
      await this.store.save(run);
      return run;
    });
  }

  async updateRun(
    runId: string,
    updater: Partial<TraceRun> | ((run: TraceRun) => void | Promise<void>),
  ): Promise<TraceRun> {
    return this.serialize(runId, async () => {
      const run = await this.store.load(runId);
      if (!run) {
        throw new Error(`Trace run "${runId}" does not exist`);
      }

      if (typeof updater === 'function') {
        await updater(run);
      } else {
        Object.assign(run, updater);
      }

      const usage = summarizeTokenUsage(run.steps);
      if (usage) {
        run.usage = usage;
      }
      const duration = summarizeModelDuration(run.steps, run.modelDurationMs ?? 0);
      if (duration !== undefined) {
        run.modelDurationMs = duration;
      }
      run.updatedAt = new Date().toISOString();
      await this.store.save(run);
      return run;
    });
  }

  load(runId: string): Promise<TraceRun | null> {
    return this.store.load(runId);
  }

  async list(query: TraceListQuery): Promise<TraceRun[]> {
    if (!this.store.list) {
      throw new Error('Configured TraceStore does not support listing runs');
    }
    return this.store.list(query);
  }

  private serialize<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(runId) ?? Promise.resolve();
    const next = previous.then(operation);
    const tracked = next.catch(() => undefined).finally(() => {
      if (this.queues.get(runId) === tracked) {
        this.queues.delete(runId);
      }
    });
    this.queues.set(runId, tracked);
    return next;
  }
}
