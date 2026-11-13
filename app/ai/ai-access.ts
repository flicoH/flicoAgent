import type { Request } from 'express';

export interface AiAccess {
  /** 业务授权返回的资源命名空间，例如项目 ID 或项目与用户 ID 的组合。 */
  scope: string;
  /** 允许更新进程配置的知识库。 */
  ingest?: boolean;
  /** 读取共享知识库管理接口。 */
  ragRead?: boolean;
  /** 对授权范围内的运行作出人工审批决定。 */
  approve?: boolean;
  /** 配置后只允许操作列出的 Agent 或直接调用列出的 Skill。 */
  agents?: readonly string[];
  skills?: readonly string[];
}

export interface AiSigningKey extends Omit<AiAccess, 'scope'> {
  secret: string;
  /** 缺省使用调用方的 key ID 隔离会话与 Trace。 */
  scope?: string;
}

export interface AiRequest extends Request {
  rawBody?: Buffer;
  aiAccess?: AiAccess;
}

/** 回调应验证会话或令牌，然后根据请求路径和调用方身份决定是否授权。 */
export type AuthorizeAi = (request: AiRequest) => AiAccess | null | Promise<AiAccess | null>;
