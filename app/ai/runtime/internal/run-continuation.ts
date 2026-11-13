import type { LlmMessage } from '../../contracts';
import type { LangChainToolCall } from '../langchain/langchain-planner.service';
import type { ExecutionResult } from '../../contracts';

/**
 * 待审批运行的持久化快照，和 waiting_approval 状态一起写入 TraceStore。
 * 恢复段使用新的图实例和当前注册表，模型、工具实例及信号由运行时重新装配。
 * 完整消息和本轮工具结果用来还原原始 tool_call 与工具应答的对应关系。
 */
export interface RunContinuation {
  /** 截至本轮 plan 结束的消息，包含模型产生的工具调用请求。 */
  messages: LlmMessage[];
  /** 当前工具批次所属的轮次和该运行的轮次上限。 */
  iteration: number;
  maxIterations: number;
  /** 模型给出的完整工具批次，保留调用顺序和原始参数。 */
  calls: LangChainToolCall[];
  /** 已执行的调用按原始顺序保存，恢复从 completed.length 位置继续。 */
  completed: Array<{ call: LangChainToolCall; result: ExecutionResult }>;
  /** 暂停前的对话版本，恢复结束时用于判断能否写回会话。 */
  memory?: { revision: string };
  /** 审批等待前剩余的全树预算，供后续分段继续扣减。 */
  budget: { models: number; children: number };
  /** 原调用方的 Agent 白名单。审批者的权限会与它取交集，缺省沿用既有授权行为。 */
  agents?: readonly string[];
}
