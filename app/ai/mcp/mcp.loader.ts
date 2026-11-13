import { Injectable } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import { ToolDefinition } from '../tool/tool.interface';
import { loadMcpConfig } from './internal/load-mcp-config';
import { McpClient } from './mcp.client';

/**
 * MCP 加载器服务 (McpLoader)
 *
 * 【架构职责】
 * 负责解析配置并自动加载/连接指定的外部 MCP Server：
 * 1. 从 ConfigService 中读取合并后的 ai.mcp 配置；
 * 2. enabled=false 或 servers 为空时安全短路，返回空数组；
 * 3. 对每个合法 Server 实例化 McpClient，触发 connect 握手与 listTools 发现；
 * 4. 将发现的 MCP 工具按规范适配为框架统一的 ToolDefinition (source: 'mcp')。
 */
@Injectable()
export class McpLoader {
  private readonly clients: McpClient[] = [];
  private readonly serverToolMap = new Map<string, ToolDefinition[]>();

  constructor(private readonly configService: ConfigService) {}

  /**
   * 获取所有活跃的 MCP 客户端列表
   */
  getClients(): McpClient[] {
    return [...this.clients];
  }

  /**
   * 获取按 Server 分组的工具映射表
   */
  getServerToolMap(): Map<string, ToolDefinition[]> {
    return this.serverToolMap;
  }

  /**
   * 执行 MCP Server 配置加载、连接握手与 Tool 适配
   *
   * @returns 适配包装后的全量 ToolDefinition 列表
   */
  async load(): Promise<ToolDefinition[]> {
    const config = loadMcpConfig(this.configService);

    // enabled=false 或 servers 空 → 返回 []
    if (!config.enabled || !config.servers || config.servers.length === 0) {
      return [];
    }

    const allTools: ToolDefinition[] = [];
    this.serverToolMap.clear();

    for (const server of config.servers) {
      const client = new McpClient(server);
      this.clients.push(client);

      // 连接并完成握手
      await client.connect();

      // 拉取工具清单
      const descriptors = await client.listTools();

      // 每个 MCP tool 适配为 ToolDefinition
      const serverTools: ToolDefinition[] = [];
      for (const desc of descriptors) {
        const toolDef: ToolDefinition = {
          name: desc.name,
          description: desc.description ?? '',
          inputSchema: desc.inputSchema ?? {},
          ...(server.approvalTools?.includes(desc.name) ? { approval: 'required' as const } : {}),
          source: 'mcp', // 必填，禁止默认 builtin
          execute: async (input: unknown, context) => {
            const signal = context?.signal;
            return client.callTool(desc.name, input, signal instanceof AbortSignal ? signal : undefined);
          },
        };

        serverTools.push(toolDef);
        allTools.push(toolDef);
      }

      this.serverToolMap.set(server.name, serverTools);
    }

    return allTools;
  }

  /**
   * 关闭所有 MCP 客户端连接并释放资源
   */
  async closeAll(): Promise<void> {
    for (const client of this.clients) {
      try {
        await client.close();
      } catch (err: any) {
        console.error(`[McpLoader] error closing client "${client.getServerName()}":`, err.message);
      }
    }
    this.clients.length = 0;
    this.serverToolMap.clear();
  }
}
