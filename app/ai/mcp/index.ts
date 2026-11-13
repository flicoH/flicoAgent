/**
 * Model Context Protocol (MCP) 客户端与工具适配子系统导出入口
 *
 * 提供 MCP 类型定义、JSON-RPC 客户端（支持 stdio 与 HTTP SSE 传输）、
 * 启动时服务发现与加载器，以及统一的 McpRegistryService。
 */
export * from './mcp.types';
export * from './mcp.client';
export * from './mcp.loader';
export * from './mcp-registry.service';
export * from './mcp.module';
