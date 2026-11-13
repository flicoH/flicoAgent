import { Injectable } from '@nestjs/common';
import { ToolDefinition } from '../tool/tool.interface';
import { ToolRegistryService } from '../tool/tool-registry.service';
import { McpLoader } from './mcp.loader';

/**
 * MCP 注册表服务 (McpRegistryService)
 *
 * 【架构职责】
 * 将 McpLoader 加载适配的外部 MCP 工具注册到全局 ToolRegistryService：
 * 1. 严格校验 tool.source === 'mcp'，禁止注入非 mcp 来源工具；
 * 2. 启动时输出统一结构日志：server 名 + 注册的 tool 名列表；
 * 3. 仅负责 MCP 工具注册，不承担 builtin 或其他类型工具的注册。
 */
@Injectable()
export class McpRegistryService {
  constructor(private readonly loader: McpLoader) {}

  /**
   * 将加载完成的 MCP 工具批量注册到全局 ToolRegistryService
   *
   * @param toolRegistry 目标全局工具注册表
   * @param loadedTools 可选直接传入的 ToolDefinition 列表
   */
  registerAll(
    toolRegistry: ToolRegistryService,
    loadedTools?: ToolDefinition[],
  ): void {
    const serverMap = this.loader.getServerToolMap();

    // 若通过参数直接传入 tools 且无 serverMap 分组元数据时的兼容支持
    if (serverMap.size === 0 && Array.isArray(loadedTools) && loadedTools.length > 0) {
      const toolNames: string[] = [];
      for (const tool of loadedTools) {
        if (tool.source !== 'mcp') {
          throw new Error(`Tool "${tool.name}" source must be "mcp", received "${tool.source}"`);
        }
        toolRegistry.register(tool);
        toolNames.push(tool.name);
      }
      console.log('[McpRegistry] registered tools:', toolNames);
      return;
    }

    // 按 server 维度注册工具并输出启动日志
    for (const [serverName, tools] of serverMap.entries()) {
      const toolNames: string[] = [];
      for (const tool of tools) {
        if (tool.source !== 'mcp') {
          throw new Error(`Tool "${tool.name}" from server "${serverName}" source must be "mcp", received "${tool.source}"`);
        }
        toolRegistry.register(tool);
        toolNames.push(tool.name);
      }
      console.log(`[McpRegistry] server "${serverName}" registered tools:`, toolNames);
    }
  }
}
