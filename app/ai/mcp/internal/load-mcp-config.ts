import { ConfigService } from '../../../config/config.service';
import { McpConfig, McpServerConfig } from '../mcp.types';

/**
 * 根配置中与 AI 相关的节点定义
 */
interface AiConfig {
  mcp?: Partial<McpConfig>;
}

/**
 * 读取并校验 ai.mcp 配置
 *
 * 【同构设计与校验规则】
 * 1. 与 load-llm-config 保持同构，通过 ConfigService 读取合并后的全局配置 ai.mcp；
 * 2. 缺省或未配置时，默认返回 { enabled: false, servers: [] }；
 * 3. 校验每个 server 条目：
 *    - 每个 server 必须有 command 或 url 之一；
 *    - 两个都有 → 抛出明确 Error（报错不要猜）；
 *    - 两个都空 → 丢弃该条目；
 *    - 缺少合法 name → 丢弃该条目；
 *    - 保留 name + (command 或 url) 的合法条目（不硬性要求必须有 command）。
 *
 * @param configService 全局配置服务
 * @returns 规范化的 McpConfig
 * @throws 当某个 server 同时配置了 command 和 url 时抛出 Error
 */
export function loadMcpConfig(configService: ConfigService): McpConfig {
  const mcp = configService.get<AiConfig>('ai')?.mcp ?? configService.get<Partial<McpConfig>>('ai.mcp');

  if (!mcp) {
    return { enabled: false, servers: [] };
  }

  const enabled = Boolean(mcp.enabled);
  const rawServers = Array.isArray(mcp.servers) ? mcp.servers : [];

  const validServers: McpServerConfig[] = [];

  for (const server of rawServers) {
    if (!server || typeof server !== 'object') {
      continue;
    }

    const name = typeof server.name === 'string' ? server.name.trim() : '';
    if (!name) {
      continue;
    }

    const hasCommand = typeof server.command === 'string' && server.command.trim().length > 0;
    const hasUrl = typeof server.url === 'string' && server.url.trim().length > 0;

    // 两个都有 → 报错不要猜
    if (hasCommand && hasUrl) {
      throw new Error(`MCP server "${name}" cannot configure both "command" and "url"`);
    }

    // 两个都空 → 丢掉
    if (!hasCommand && !hasUrl) {
      continue;
    }

    // 保留 name + (command 或 url) 的合法条目
    validServers.push({
      ...server,
      name,
    });
  }

  return {
    enabled,
    servers: validServers,
  };
}
