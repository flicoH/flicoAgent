import { Injectable } from '@nestjs/common';
import { SkillScannerService } from '../skill/skill-scanner.service';
import { ToolRegistryService } from './tool-registry.service';
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
   * @param context 当前运行链路上下文（如 runId、agent 名称）；仅传给 Skill
   * @returns 结构化执行结果 ExecutionResult
   */
  async execute(
    name: string,
    input: unknown,
    context: Record<string, unknown>,
  ): Promise<ExecutionResult> {
    // 1. 优先匹配业务 Skill
    const skill = this.skills.get(name);
    if (skill) {
      try {
        return {
          type: 'skill',
          name,
          output: await skill.execute(input, context),
        };
      } catch (error) {
        return this.executionError(name, error);
      }
    }

    // 2. 次选匹配通用 Tool
    const tool = this.tools.get(name);
    if (tool) {
      try {
        return {
          type: 'tool',
          name,
          source: tool.source ?? 'builtin',
          output: await tool.execute(input),
        };
      } catch (error) {
        return this.executionError(name, error);
      }
    }

    // 3. 能力未注册：返回结构化观察错误供模型在下一轮理解
    return {
      type: 'observe',
      name,
      error: {
        code: 'CAPABILITY_NOT_FOUND',
        message: `Skill or tool "${name}" is not registered`,
      },
    };
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
        code: 'EXECUTION_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
