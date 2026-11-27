/**
 * 单个 MCP Server 的配置声明
 *
 * 【传输方式二选一】
 * - stdio：通过 command/args/env/cwd 由框架本地拉起子进程通信；
 * - http：通过 url/headers 连已运行的外部独立 MCP 服务，不拉起子进程。
 */
export interface McpServerConfig {
  /** Server 唯一标识名称 */
  name: string;
  /** 通信或调用超时时间（毫秒） */
  timeoutMs?: number;

  // stdio 本地拉起（与 url 二选一）
  /** 启动命令（例如 node） */
  command?: string;
  /** 命令参数列表 */
  args?: string[];
  /** 环境变量 */
  env?: Record<string, string>;
  /** 子进程运行目录，缺省为 demo 项目根目录 */
  cwd?: string;

  // 远程已有服务（与 command 二选一）
  /** 远程已有服务 URL */
  url?: string;
  /** 传递给远程服务的自定义请求头 */
  headers?: Record<string, string>;
  /** 需要人工审批的工具名称列表 */
  approvalTools?: string[];
}

/**
 * 全局 ai.mcp 配置结构
 */
export interface McpConfig {
  /** 是否启用 MCP 客户端加载与工具注册 */
  enabled?: boolean;
  /** MCP Server 配置列表 */
  servers: McpServerConfig[];
}

/**
 * MCP tools/list 单项描述契约
 */
export interface McpToolDescriptor {
  /** 工具唯一标识名称 */
  name: string;
  /** 工具功能描述 */
  description?: string;
  /** 工具入参 Schema (JSON Schema) */
  inputSchema?: unknown;
}
