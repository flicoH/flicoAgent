import type { LlmAssistantMessage } from '../llm/llm.interface';

/**
 * Agent ReAct 循环的最大迭代轮次上限
 * 防止模型陷入无法自愈的死循环或死锁消耗过多 token
 */
export const MAX_ITERATIONS = 5;

/**
 * 规划动作：调用能力 (InvokePlanAction)
 * 表示模型规划出在当前轮次需要执行某个已注册的 Skill 或 Tool
 */
export interface InvokePlanAction {
  /** 动作类型：'invoke' */
  type: 'invoke';
  /** 待调用的技能或工具注册名 */
  name: string;
  /** 传递给技能或工具 execute 方法的参数对象 */
  input: unknown;
}

/**
 * 规划动作：最终产出 (FinalPlanAction)
 * 表示模型认为已有信息足够回答用户提问，结束推理循环
 */
export interface FinalPlanAction {
  /** 动作类型：'final' */
  type: 'final';
  /** 最终回答文本 */
  output: string;
}

/**
 * 单轮规划动作联合类型（只能是“调用能力”或“得出最终结论”）
 */
export type PlanAction = InvokePlanAction | FinalPlanAction;

/**
 * 规划器单轮推理结果 (PlanResult)
 */
export interface PlanResult {
  /** 解析出的决策动作（invoke 或 final） */
  action: PlanAction;
  /** 模型返回的原始助手消息（包含 content 与 tool_calls），必须按原样写回多轮会话历史 */
  response: LlmAssistantMessage;
  /** 本次工具调用的唯一标识 ID（原生 tool_call.id 或 fallback 兜底生成），用于关联对应的 tool 观察结果 */
  toolCallId?: string;
}

/**
 * 执行器单次执行结果 (ExecutionResult)
 */
export interface ExecutionResult {
  /** 命中的能力类别；若在执行前或执行中发生异常则为 'observe' 观察错误 */
  type: 'skill' | 'tool' | 'observe';
  /** 本次执行的能力名称 */
  name: string;
  /** 能力来源分类（如 'builtin' | 'mcp'） */
  source?: 'builtin' | 'mcp';
  /** 成功执行后的输出结果 */
  output?: unknown;
  /** 结构化错误信息（不向循环外抛出异常，而是让下一轮模型感知并自愈） */
  error?: {
    code: string;
    message: string;
  };
}

/**
 * 运行追踪步骤类型枚举
 * - 'plan': 规划动作
 * - 'skill': 业务技能执行
 * - 'tool': 通用工具执行
 * - 'observe': 模型对执行结果的观察事实
 * - 'final': 最终输出步骤
 * - 'guardrail': 安全护栏拦截步骤
 */
export type StepType = 'plan' | 'skill' | 'tool' | 'observe' | 'final' | 'guardrail';

/**
 * 运行轨迹中的单个步骤实体 (Step)
 */
export interface Step {
  /** 步骤类型 */
  type: StepType;
  /** 所在循环轮次（从 1 开始递增） */
  iteration: number;
  /** 能力名称（仅在 skill/tool/observe 相关步骤中存在） */
  name?: string;
  /** 工具来源分类（仅在 tool 步骤中存在，'builtin' | 'mcp'） */
  source?: 'builtin' | 'mcp';
  /** 输入数据 */
  input?: unknown;
  /** 输出数据 */
  output?: unknown;
  /** 结构化错误信息 */
  error?: {
    code: string;
    message: string;
  };
  /** 对应的 tool_call_id，用于步骤与对话链路精准匹配 */
  toolCallId?: string;
  /** 步骤产生时的 ISO 时间戳 */
  timestamp: string;
}

/**
 * Agent 运行对外输出的稳定响应合同 (RunResult)
 * 【重要】：runId、output、steps、threadId 字段名称在合同中严格锁死，不得变更
 */
export interface RunResult {
  /** 本次运行的唯一 ID */
  runId: string;
  /** Agent 产出的最终文本结论 */
  output: string;
  /** 完整的按发生时序排列的执行步骤列表 */
  steps: Step[];
  /** 所属多轮会话线程 ID */
  threadId: string;
}

/**
 * 持久化存储的完整运行链路实体 (TraceRun)
 */
export interface TraceRun extends RunResult {
  /** 执行本次运行的 Agent 名称 */
  agent: string;
  /** 调用方传入的初始入参 */
  input: unknown;
  /** 记录创建时间（ISO 字符串） */
  createdAt: string;
  /** 最后更新时间（ISO 字符串） */
  updatedAt: string;
}

/**
 * 运行时旁路事件 (RuntimeEvent)
 * 用于在流式接口 (SSE) 中向客户端实时推送状态：
 * - delta: 字符或词级别的内容流式增量
 * - step: 步骤完成事件（通知客户端当前处于哪个 plan/tool/final 阶段）
 */
export type RuntimeEvent =
  | { type: 'delta'; content: string }
  | { type: 'step'; step: Step };
