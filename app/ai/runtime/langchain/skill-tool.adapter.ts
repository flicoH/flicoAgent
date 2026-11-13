import { Injectable } from '@nestjs/common';
import { StructuredTool } from '@langchain/core/tools';
import { SkillScannerService } from '../../skill/skill-scanner.service';
import { ToolRegistryService } from '../../tool/tool-registry.service';
import { SkillDefinition } from '../../skill/skill.interface';
import { ToolDefinition } from '../../tool/tool.interface';

/**
 * 通用序列化辅助函数
 * 将工具执行产生的任意对象、基本类型或字符串安全转换为字符串格式
 *
 * @param value 待序列化的任意结果数据
 * @returns 字符串内容（若为对象则序列化为 JSON 字符串）
 */
function serializeResult(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

/**
 * 包装为 LangChain 规范的 StructuredTool 实例 (AdaptedStructuredTool)
 *
 * 【适配机制】
 * 继承 LangChain 核心 `StructuredTool` 类：
 * 1. `name` 与 `description` 直接对齐 `SkillDefinition` 或 `ToolDefinition` 的元数据；
 * 2. `schema` 承载 JSON Schema 参数约束，供 ChatOpenAI 的 `bindTools` 解析；
 * 3. `_call(arg)` 钩子负责委托调用底层 `executeFn` 并自动序列化产出。
 */
export class AdaptedStructuredTool extends StructuredTool {
  /** 工具唯一标识名称 */
  name: string;
  /** 工具功能描述文本 */
  description: string;
  /** JSON Schema 规范参数结构 */
  schema: any;

  /**
   * 构造适配后的 LangChain StructuredTool
   *
   * @param name 工具标识
   * @param description 工具描述
   * @param schema 入参 JSON Schema 定义
   * @param executeFn 具体的底层异步执行委托函数
   */
  constructor(
    name: string,
    description: string,
    schema: unknown,
    private readonly executeFn: (input: unknown) => Promise<unknown>,
  ) {
    super();
    this.name = name;
    this.description = description || '';
    this.schema = schema && typeof schema === 'object' ? schema : { type: 'object', properties: {} };
  }

  /**
   * LangChain 工具执行回调入口
   *
   * @param arg 模型解析传入的参数对象
   * @returns 序列化后的执行结果字符串
   */
  protected async _call(arg: unknown): Promise<string> {
    const result = await this.executeFn(arg);
    return serializeResult(result);
  }
}

/**
 * 技能与工具适配器 (SkillToolAdapter)
 *
 * 【架构设计与核心职责】
 * 将业务 Skill 及通用 Tool（含 MCP 外部工具）统一转换为 LangChain `StructuredTool` 实例：
 * 1. 协议桥接：打通框架自研 `SkillDefinition`/`ToolDefinition` 与 LangChain 工具链生态；
 * 2. 调度委托：工具执行并不内嵌业务逻辑，而是严格转调底层的 `SkillScannerService` 与 `ToolRegistryService`；
 * 3. 白名单筛选：根据 Agent 声明的 `skills` 与 `tools` 白名单进行动态筛选组装。
 */
@Injectable()
export class SkillToolAdapter {
  /**
   * 构造函数注入技能扫描服务与工具注册服务
   *
   * @param skills 业务技能扫描与注册服务
   * @param tools 通用工具注册表服务
   */
  constructor(
    private readonly skills: SkillScannerService,
    private readonly tools: ToolRegistryService,
  ) {}

  /**
   * 将单个业务 Skill 适配为 LangChain StructuredTool
   *
   * @param skill 业务技能定义契约
   * @param context 可选的调用链路上下文（透传 runId、agentName 等）
   * @returns 适配生成的 StructuredTool
   */
  adaptSkill(skill: SkillDefinition, context: Record<string, unknown> = {}): StructuredTool {
    return new AdaptedStructuredTool(
      skill.name,
      skill.description,
      skill.inputSchema,
      this.createSkillExecutor(skill.name, context),
    );
  }

  /**
   * 将单个通用 Tool（包含 MCP 外部动态注册工具）适配为 LangChain StructuredTool
   *
   * @param tool 通用工具定义契约
   * @returns 适配生成的 StructuredTool
   */
  adaptTool(tool: ToolDefinition): StructuredTool {
    return new AdaptedStructuredTool(
      tool.name,
      tool.description,
      tool.inputSchema,
      this.createToolExecutor(tool.name),
    );
  }

  /**
   * 根据目标 Agent 白名单筛选并批量适配开放的 Skill 与 Tool（含 MCP 工具）
   *
   * @param skillNames 允许该 Agent 调用的 Skill 名称清单
   * @param toolNames 允许该 Agent 调用的 Tool 名称清单
   * @param context 当前运行链路上下文
   * @returns 批量适配后的 LangChain StructuredTool 数组
   */
  adaptForAgent(
    skillNames: string[] = [],
    toolNames: string[] = [],
    context: Record<string, unknown> = {},
  ): StructuredTool[] {
    const adapted: StructuredTool[] = [];

    // 1. 适配业务技能 (Skill)
    for (const name of skillNames) {
      const skill = this.skills.get(name);
      if (skill) {
        adapted.push(this.adaptSkill(skill, context));
      }
    }

    // 2. 适配通用工具与 MCP 外部工具 (Tool)
    for (const name of toolNames) {
      const tool = this.tools.get(name);
      // 同名时与执行器保持一致，只有已获准且存在的 Skill 优先。
      if (tool && !adapted.some(capability => capability.name === name)) {
        adapted.push(this.adaptTool(tool));
      }
    }

    return adapted;
  }

  /**
   * 构造业务 Skill 的执行委托闭包
   * 运行时动态从 SkillScannerService 查找并执行，透传 SkillContext
   *
   * @param skillName 目标技能名称
   * @param context 链路上下文
   * @returns 委托执行函数
   */
  private createSkillExecutor(skillName: string, context: Record<string, unknown>) {
    return async (input: unknown) => {
      const target = this.skills.get(skillName);
      if (!target) {
        throw new Error(`Skill "${skillName}" is not registered`);
      }
      if (target.approval === 'required') throw new Error('Capability requires managed run approval');
      return target.execute(input, context);
    };
  }

  /**
   * 构造通用 Tool 的执行委托闭包
   * 运行时动态从 ToolRegistryService 查找并执行
   *
   * @param toolName 目标工具名称
   * @returns 委托执行函数
   */
  private createToolExecutor(toolName: string) {
    return async (input: unknown) => {
      const target = this.tools.get(toolName);
      if (!target) {
        throw new Error(`Tool "${toolName}" is not registered`);
      }
      if (target.approval === 'required') throw new Error('Capability requires managed run approval');
      return target.execute(input);
    };
  }
}
