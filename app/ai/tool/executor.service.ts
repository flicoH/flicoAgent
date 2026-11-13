import { Injectable } from '@nestjs/common';
import Ajv from 'ajv';
import { SkillScannerService } from '../skill/skill-scanner.service';
import { ToolRegistryService } from './tool-registry.service';
import { readRetrievalCitations } from '../rag/citations';
import { ExecutionResult } from '../contracts';

/**
 * 能力执行器服务 (ExecutorService)
 *
 * 【调度执行中枢】
 * 接收 Planner 解析出的调用指令，将能力名称分发给对应的具体实现：
 * 1. 优先在 `SkillScannerService` 中匹配业务技能（传入 SkillContext 上下文）；
 * 2. 次选在 `ToolRegistryService` 中匹配通用工具；同名时 Skill 优先；
 * 3. 错误自愈设计：若发生未找到能力或执行异常，不直接抛错中断循环，
 *    而是捕获并封装为结构化的 `observe` 观察错误，使得模型在下一轮 ReAct 中获知失败原因并尝试自愈或纠错。
 */
@Injectable()
export class ExecutorService {
  // 复用编译后的 JSON Schema，避免每个模型工具调用重复编译。
  private readonly validator = new Ajv();
  /**
   * 构造函数注入技能扫描服务与工具注册服务
   * @param skills 业务技能扫描器
   * @param tools 通用工具注册表
   */
  constructor(
    private readonly skills: SkillScannerService,
    private readonly tools: ToolRegistryService,
  ) {}

  /**
   * 执行指定名称的能力（Skill 或 Tool）
   *
   * @param name 能力名称
   * @param input 模型传入的实参
   * @param context 传给 Skill 或 Tool 的运行上下文，可包含 runId、中止信号和幂等键
   * @param allowed 当前 Agent 的 Skill 和 Tool 白名单，两个名称空间分别校验
   * @param approved 编排器验证当前调用已批准后传入的能力类别，用于区分同名 Skill 与 Tool
   * @returns 结构化执行结果 ExecutionResult
   */
  async execute(
    name: string,
    input: unknown,
    context: Record<string, unknown>,
    allowed?: { skills: readonly string[]; tools: readonly string[] },
    approved?: 'skill' | 'tool',
  ): Promise<ExecutionResult> {
    try {
      // 分别检查两个命名空间，防止同名 Skill 借 Tool 的白名单被调用。
      const skill = (!allowed || allowed.skills.includes(name)) ? this.skills.get(name) : undefined;
      if (skill) {
        return {
          type: 'skill',
          name,
          output: await this.invokeSkill(skill, input, context, approved === 'skill'),
        };
      }

      const tool = (!allowed || allowed.tools.includes(name)) ? this.tools.get(name) : undefined;
      if (tool) {
        this.validateInput(tool.inputSchema, input);
        if (tool.approval === 'required' && approved !== 'tool') throw new CapabilityApprovalRequired();
        const output = await tool.execute(input, context);
        // 检索工具在内存中登记可信来源，任意工具输出里的普通同名字段无法生成引用。
        const citations = readRetrievalCitations(output);
        return {
          type: 'tool',
          name,
          source: tool.source ?? 'builtin',
          output,
          ...(citations ? { citations } : {}),
        };
      }
    } catch (error) {
      return this.executionError(name, error);
    }

    const denied = allowed && !allowed.skills.includes(name) && !allowed.tools.includes(name);
    return {
      type: 'observe',
      name,
      error: {
        code: denied ? 'CAPABILITY_NOT_ALLOWED' : 'CAPABILITY_NOT_FOUND',
        message: denied ? `Agent cannot call "${name}"` : `Skill or tool "${name}" is not registered`,
      },
    };
  }

  /** 使用与 execute 相同的白名单及同名优先级，校验无误后才请求审批。 */
  approvalFor(name: string, input: unknown, allowed: { skills: readonly string[]; tools: readonly string[] }) {
    const skill = allowed.skills.includes(name) ? this.skills.get(name) : undefined;
    const tool = !skill && allowed.tools.includes(name) ? this.tools.get(name) : undefined;
    const target = skill || tool;
    if (!target || target.approval !== 'required') return undefined;
    this.validateInput(target.inputSchema, input);
    return skill ? 'skill' as const : 'tool' as const;
  }

  /**
   * HTTP 直调和 Agent 运行共用参数及审批校验。
   * approved 默认关闭，只有编排器恢复已批准的当前调用时才传入 true。
   */
  invokeSkill(skill: NonNullable<ReturnType<SkillScannerService['get']>>, input: unknown, context: Record<string, unknown>, approved = false): Promise<unknown> {
    this.validateInput(skill.inputSchema, input);
    if (skill.approval === 'required' && !approved) throw new CapabilityApprovalRequired();
    return skill.execute(input, context);
  }

  private validateInput(schema: unknown, input: unknown): void {
    if (schema === undefined || schema === null) return;
    if ((typeof schema !== 'object' && typeof schema !== 'boolean') || Array.isArray(schema)) {
      throw new Error('Invalid capability input schema');
    }
    if (!this.validator.validate(schema, input)) {
      throw new InvalidCapabilityInput(this.validator.errorsText());
    }
  }

  /**
   * 将捕获的异常转换为统一的 observe 观察错误结构
   *
   * @param name 能力名称
   * @param error 捕获到的异常对象
   * @returns 结构化 ExecutionResult
   */
  private executionError(name: string, error: unknown): ExecutionResult {
    return {
      type: 'observe',
      name,
      error: {
        code: error instanceof CapabilityApprovalRequired ? 'APPROVAL_REQUIRED'
          : error instanceof InvalidCapabilityInput ? 'INVALID_CAPABILITY_INPUT' : 'EXECUTION_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export class InvalidCapabilityInput extends Error {}

export class CapabilityApprovalRequired extends Error {
  constructor() { super('This capability requires approval in a managed Agent run'); }
}
