import type { ModuleRef } from '@nestjs/core';
import type { ConfigService } from '../../config/config.service';

/**
 * 统一工具契约定义 (ToolDefinition)
 *
 * 【职责划分】
 * Tool 代表通用、底层的可调用工具（例如框架内置的检索工具 `retrieve`、
 * RAG 检索工具、或通过 MCP 协议动态转接的外部工具等）。
 *
 * 与业务侧的 Skill 相比，Tool 更加通用底层，通过 `ToolRegistryService` 统一管理。
 */
export interface ToolDefinition {
  /** 有副作用的能力可要求人工审批后执行。 */
  approval?: 'required';
  /**
   * 工具的唯一注册名称
   * 同时作为大模型 Function Calling 中的函数名，如 'retrieve'
   */
  name: string;

  /**
   * 工具的能力描述
   * 面向大模型与调用方，清晰说明工具的用途及行为
   */
  description: string;

  /**
   * 工具入参的 JSON Schema 描述
   * 供大模型理解参数结构并在请求时生成对应的 JSON 参数
   */
  inputSchema: unknown;

  /**
   * 执行该工具的具体逻辑
   *
   * @param input 模型规划器解析生成的结构化入参
   * @returns 工具执行后产出的可序列化结果
   */
  execute(input: unknown, context?: Record<string, unknown>): Promise<unknown>;

  /**
   * 标记该工具的来源分类
   * 例如：'builtin'（框架内置）、'mcp'（模型上下文协议）等
   */
  source?: 'builtin' | 'mcp';
}

/**
 * 内置工具工厂所需的框架依赖上下文 (BuiltinToolDeps)
 */
export interface BuiltinToolDeps {
  /**
   * NestJS 容器模块引用 (ModuleRef)
   * 允许内置工具按需动态检索已注入 Nest 容器的各类 Provider/Service 实例
   */
  moduleRef: ModuleRef;
  config?: ConfigService;
}

/**
 * 内置工具工厂函数类型定义
 * 接收框架依赖项，构造并返回一个 ToolDefinition 实例
 */
export type BuiltinToolFactory = (deps: BuiltinToolDeps) => ToolDefinition;
