import type { AgentDefinition } from '../../agent/agent.interface';

/** 由编排器解释的保留工具名，注册表和业务 Skill 扫描都会拒绝同名声明。 */
export const DELEGATE_TOOL = 'agent-delegate';

/** 提供给模型的参数契约。目标是否可访问仍由编排器逐次检查。 */
export const delegateSchema = {
  type: 'object',
  required: ['agent', 'input'],
  additionalProperties: false,
  properties: {
    agent: { type: 'string', minLength: 1 },
    input: {},
  },
};

export interface DelegationContext {
  /** 根运行与所有子运行共用计数对象。审批挂起前将当前值持久化。 */
  budget: { models: number; children: number };
  /** 从根到当前 Agent 的名称序列，用于限制调用深度和阻止回到任一祖先。 */
  lineage: string[];
  /** 直接父运行和整棵委派树根运行的 Trace ID。 */
  parentRunId?: string;
  rootRunId?: string;
}

/** 去重并限制在调用方的白名单内。调用处根据当前祖先列表和剩余预算进一步筛选。 */
export function delegatable(agent: AgentDefinition, allowed?: readonly string[]) {
  return [...new Set(agent.delegates ?? [])].filter(name => !allowed || allowed.includes(name));
}
