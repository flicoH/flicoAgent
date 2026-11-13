import { CanActivate, ExecutionContext, ForbiddenException, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { AiAccess, AiRequest, AiSigningKey, AuthorizeAi } from '../../ai/ai-access';
import { ConfigService } from '../../config/config.service';

const LEGACY_WINDOW_MS = 600_000;
const AI_WINDOW_MS = 300_000;

/** 接受 13 位 Unix 毫秒时间戳。提前或滞后的时间都必须落在调用方给定的窗口内。 */
function isFreshTimestamp(value: unknown, now: number, window: number): value is string {
  return typeof value === 'string' && /^\d{13}$/.test(value) && Math.abs(now - Number(value)) <= window;
}

@Injectable()
export class ApiSignGuard implements CanActivate {
  private readonly nonces = new Map<string, number>();

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    const request = context.switchToHttp().getRequest<AiRequest>();
    const path = request.path.toLowerCase();
    if (path === '/api/ai' || path.startsWith('/api/ai/')) {
      return this.authorizeAi(request);
    }

    if (!path.startsWith('/api/')) {
      return true;
    }
    const whiteList = this.config.get<string[]>('apiSignVerify.whiteList') ?? [];
    if (whiteList.includes(request.path)) {
      return true;
    }

    if (!this.hasLegacySignature(request)) {
      throw new HttpException({
        success: false,
        message: 'signature not correct or api timeout!!',
        code: 445,
      }, HttpStatus.OK);
    }
    return true;
  }

  private hasLegacySignature({ headers }: AiRequest): boolean {
    // 旧 Dashboard 仍发送这两个请求头。AI 路由需要独立的业务身份或服务端密钥。
    const { s_sign: sign, s_t: timestamp } = headers;
    if (!isFreshTimestamp(timestamp, Date.now(), LEGACY_WINDOW_MS)) {
      return false;
    }
    const key = 'klx05hb3n1c9ujp8uhxbs2ikkiowp212';
    return this.matchesSignature(sign, createHash('md5').update(`${key}_${timestamp}`).digest());
  }

  private async authorizeAi(request: AiRequest): Promise<boolean> {
    const authorize = this.config.get<AuthorizeAi>('ai.access.authorize');
    const access = request.headers['x-agent-key-id'] !== undefined
      ? this.verifyAiSignature(request)
      : this.hasLegacySignature(request) && authorize ? await authorize(request) : null;
    request.aiAccess = this.validateAiAccess(access, request.path);
    return true;
  }

  /** 验证授权范围和可选的能力白名单。无有效授权时返回 401，缺少灌库权限时返回 403。 */
  private validateAiAccess(access: AiAccess | null, path: string): AiAccess {
    if (!access || typeof access.scope !== 'string' || !access.scope.trim()) {
      throw new UnauthorizedException('AI API authentication required');
    }
    if ([access.agents, access.skills].some(list => list !== undefined
      && (!Array.isArray(list) || list.some(name => typeof name !== 'string')))) {
      throw new UnauthorizedException('Invalid AI access configuration');
    }
    if (/^\/api\/ai\/rag\/ingest\/?$/i.test(path) && access.ingest !== true) {
      throw new ForbiddenException('RAG ingestion is not allowed');
    }
    return { ...access, scope: access.scope.trim() };
  }

  private verifyAiSignature(request: AiRequest): AiAccess | null {
    const { headers } = request;
    const keyId = headers['x-agent-key-id'];
    const nonce = headers['x-agent-nonce'];
    const timestamp = headers.s_t;
    const now = Date.now();
    if (typeof keyId !== 'string' || !/^[\w-]{1,128}$/.test(keyId)
      || typeof nonce !== 'string' || !/^[\w-]{16,128}$/.test(nonce)
      || !isFreshTimestamp(timestamp, now, AI_WINDOW_MS)) {
      return null;
    }
    const keys = this.config.get<Record<string, AiSigningKey>>('ai.access.keys');
    const key = keys && Object.hasOwn(keys, keyId) ? keys[keyId] : undefined;
    if (typeof key?.secret !== 'string' || !key.secret) {
      return null;
    }
    const message = this.buildSigningMessage(request, keyId, timestamp, nonce);
    if (message === null || !this.matchesSignature(headers.s_sign, createHmac('sha256', key.secret).update(message).digest())) {
      return null;
    }
    if (!this.claimNonce(keyId, nonce, now)) return null;
    const { secret: _secret, ...access } = key;
    return { ...access, scope: key.scope ?? keyId };
  }

  /**
   * 按协议拼接 key ID、方法、原始 URL、时间戳、nonce 和正文摘要。
   * 请求携带正文却缺少 rawBody 时返回 null，拒绝用空正文摘要验签。
   */
  private buildSigningMessage(
    { headers, method, originalUrl, rawBody, body }: AiRequest,
    keyId: string,
    timestamp: string,
    nonce: string,
  ): string | null {
    if (!rawBody && (body !== undefined || Number(headers['content-length']) > 0 || headers['transfer-encoding'])) {
      return null;
    }
    const bodyDigest = createHash('sha256').update(rawBody ?? '').digest('hex');
    return [keyId, method, originalUrl, timestamp, nonce, bodyDigest].join('\n');
  }

  /**
   * 按 key ID 登记 nonce，重复使用时返回 false。
   * 保留两个签名窗口，覆盖客户端时间戳领先服务器一个完整窗口的情况。
   */
  private claimNonce(keyId: string, nonce: string, now: number): boolean {
    for (const [usedNonce, expiresAt] of this.nonces) {
      if (expiresAt > now) break;
      this.nonces.delete(usedNonce);
    }
    const nonceKey = `${keyId}:${nonce}`;
    if (this.nonces.has(nonceKey)) {
      return false;
    }
    this.nonces.set(nonceKey, now + 2 * AI_WINDOW_MS + 1);
    return true;
  }

  private matchesSignature(value: string | string[] | undefined, expected: Buffer): boolean {
    return typeof value === 'string' && value.length === expected.length * 2
      && /^[a-f\d]+$/i.test(value) && timingSafeEqual(Buffer.from(value, 'hex'), expected);
  }
}
