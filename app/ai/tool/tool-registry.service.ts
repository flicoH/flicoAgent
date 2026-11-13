import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ConfigService } from '../../config/config.service';
import { DELEGATE_TOOL } from '../runtime/internal/delegation';
import { builtinTools } from './builtin';
import { ToolDefinition } from './tool.interface';

/**
 * 工具注册表服务 (ToolRegistryService)
 *
 * 【核心职责】
 * 统一管理框架内置工具 (builtin)、RAG 检索工具、以及 MCP 外部工具的注册与查询：
 * 1. 模块初始化 (onModuleInit) 时，自动遍历执行 `builtinTools` 工厂，完成内置工具实例化并登记；
 * 2. 提供 `register` 方法支持运行时动态扩展注册其他工具；
 * 3. 严格校验工具名称唯一性，防止同名冲突；
 * 4. 向 Controller 和 Runtime 提供工具检索与列表查询接口。
 */
@Injectable()
export class ToolRegistryService implements OnModuleInit {
  /** 维护以工具 name 为唯一主键的 ToolDefinition 内存字典 */
  private readonly tools = new Map<string, ToolDefinition>();

  /**
   * 构造函数注入 ModuleRef，用于按需传给内置工具工厂以访问 Nest 容器
   * @param moduleRef NestJS 模块引用
   */
  constructor(private readonly moduleRef: ModuleRef, @Optional() private readonly config?: ConfigService) {}

  /**
   * 模块生命周期初始化钩子：实例化并注册所有框架内置工具
   */
  onModuleInit(): void {
    // 注册表不直接内联任何具体工具实现，而是遍历工厂清单并通过标准 register 接口注册
    for (const createTool of builtinTools) {
      this.register(createTool({ moduleRef: this.moduleRef, config: this.config }));
    }
    // 控制台输出已注册工具名称，便于启动自检
    console.log('[ToolRegistry] registered tools:', this.listNames());
  }

  /**
   * 注册一个工具定义
   *
   * @param tool 待注册的 ToolDefinition
   * @throws 当 tool.name 为空或已存在重名工具时抛出 Error
   */
  register(tool: ToolDefinition): void {
    if (!tool.name) {
      throw new Error('Tool name is required');
    }
    if (tool.name === DELEGATE_TOOL) throw new Error('Tool name is reserved for Agent delegation');
    if (tool.approval !== undefined && tool.approval !== 'required') throw new Error('Invalid tool approval policy');
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool name "${tool.name}"`);
    }
    this.tools.set(tool.name, {
      ...tool,
      source: tool.source ?? 'builtin',
    });
  }

  /**
   * 按名称获取已注册工具
   *
   * @param name 工具注册名称
   * @returns 匹配的 ToolDefinition，未注册则返回 undefined
   */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * 获取所有已注册工具的定义列表快照
   *
   * @returns 工具定义数组
   */
  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /**
   * 获取所有已注册工具的名称列表
   *
   * @returns 工具名称字符串数组
   */
  listNames(): string[] {
    return [...this.tools.keys()];
  }
}
