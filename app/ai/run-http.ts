import { BadRequestException } from '@nestjs/common';
import type { AiAccess } from './ai-access';
import type { TraceRun } from './contracts';

/** 公共运行元数据。列表省略正文及步骤，详情和 SSE 去除内部恢复状态。 */
export function runSummary(run: TraceRun) {
  const { runId, agent, threadId, createdAt, updatedAt, failure, usage, modelDurationMs, parentRunId, rootRunId } = run;
  // 旧 Trace 没有状态字段，只从已有明确终态步骤推断；不把半截步骤当成成功。
  const last = run.steps?.at(-1);
  const legacy = last?.type === 'guardrail' || last?.error ? 'failed'
    : last?.type === 'final' ? 'succeeded' : 'interrupted';
  return { runId, agent, threadId, createdAt, updatedAt, failure, usage, modelDurationMs,
    parentRunId, rootRunId, status: run.status ?? legacy };
}

/** 运行归属与 Agent 权限同时匹配。空白名单表示调用方没有可访问的 Agent。 */
export function canReadRun(run: TraceRun, access?: AiAccess): boolean {
  return run.scope === access?.scope && (!access?.agents || access.agents.includes(run.agent));
}

/** 从原始查询参数读取范围内的整数。缺参使用默认值，重复参数数组或小数直接返回 400。 */
export function readPageNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new BadRequestException('Invalid pagination parameter');
  }
  return Number(value);
}
