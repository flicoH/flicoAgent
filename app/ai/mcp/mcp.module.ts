import { Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ToolModule } from '../tool/tool.module';
import { ToolRegistryService } from '../tool/tool-registry.service';
import { McpLoader } from './mcp.loader';
import { McpRegistryService } from './mcp-registry.service';

/**
 * MCP (Model Context Protocol) 模块 (McpModule)
 *
 * 【职责与生命周期】
 * 1. onModuleInit：调用 McpLoader 完成配置加载与客户端握手，再通过 McpRegistryService 注册到 ToolRegistry；
 * 2. onModuleDestroy：安全关闭所有 McpClient 连接（stdio 终止本地子进程；HTTP 断开会话并不干扰远端服务）；
 * 3. 导出 McpLoader 与 McpRegistryService 供测试或其它上层模块依赖。
 */
@Module({
  imports: [ToolModule],
  providers: [McpLoader, McpRegistryService],
  exports: [McpLoader, McpRegistryService],
})
export class McpModule implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly loader: McpLoader,
    private readonly registry: McpRegistryService,
    private readonly toolRegistry: ToolRegistryService,
  ) {}

  /**
   * 模块初始化：先加载 MCP 工具，再将其统一登记入 ToolRegistry
   */
  async onModuleInit(): Promise<void> {
    const tools = await this.loader.load();
    this.registry.registerAll(this.toolRegistry, tools);
  }

  /**
   * 模块销毁：断开所有 MCP 连接并释放资源
   */
  async onModuleDestroy(): Promise<void> {
    await this.loader.closeAll();
  }
}
