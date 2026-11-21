import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { agentRequestSignature } from '../../ai/access/request-signature';
import type { AgentRunAccess } from '../../ai/contracts';
import { ConfigService } from '../../config/config.service';

const agentRoute = /^\/api\/ai\/(?:agent\/run(?:\/stream)?|trace\/[^/]+(?:\/usage)?)\/?$/i;
const signingWindowMs = 5 * 60 * 1000;

interface AgentAccessConfig {
  keys?: Record<string, AgentRunAccess & { secret: string }>;
  authorize?: (request: Request) => AgentRunAccess | null | Promise<AgentRunAccess | null>;
}

@Injectable()
export class ApiSignGuard implements CanActivate {
  private readonly seenNonces = new Map<string, number>();

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    const request = context.switchToHttp().getRequest<RawBodyRequest<Request>>();

    if (agentRoute.test(request.path)) {
      const access = this.config.get<AgentAccessConfig>('ai.access');
      if (request.headers['x-agent-key-id'] !== undefined || request.headers['x-agent-nonce'] !== undefined) {
        this.verifyAgentSignature(request, access?.keys);
        return true;
      }
      if (access?.authorize) {
        this.verifyLegacySignature(request);
        return this.authorizeSession(request, access.authorize);
      }
      if (access?.keys && Object.keys(access.keys).length > 0) {
        throw new UnauthorizedException('Agent signing credentials required');
      }
    }
    if (!request.path.startsWith('/api/')) {
      return true;
    }
    const whiteList = this.config.get<string[]>('apiSignVerify.whiteList') ?? [];
    if (whiteList.includes(request.path)) {
      return true;
    }

    this.verifyLegacySignature(request);
    return true;
  }

  private verifyLegacySignature(request: Request): void {
    const { s_sign: sign, s_t: st } = request.headers;
    const signKey = 'klx05hb3n1c9ujp8uhxbs2ikkiowp212';
    const signature = createHash('md5').update(`${signKey}_${st}`).digest('hex').toLowerCase();
    if (
      typeof sign !== 'string' || typeof st !== 'string' || !sign || !st ||
      signature !== sign.toLowerCase() || Date.now() - Number(st) > 600000
    ) {
      throw new HttpException({
        success: false,
        message: 'signature not correct or api timeout!!',
        code: 445,
      }, HttpStatus.OK);
    }
  }

  private async authorizeSession(request: Request, authorize: NonNullable<AgentAccessConfig['authorize']>): Promise<boolean> {
    const access = await authorize(request);
    if (!access?.scope) {
      throw new UnauthorizedException('Agent session is unauthorized');
    }
    request.agentRunAccess = access;
    return true;
  }

  private verifyAgentSignature(request: RawBodyRequest<Request>, keys?: AgentAccessConfig['keys']): void {
    const { 'x-agent-key-id': keyId, 'x-agent-nonce': nonce, s_t: timestamp, s_sign: signature } = request.headers;
    const now = Date.now();
    if (typeof keyId !== 'string' || !keys || !Object.hasOwn(keys, keyId)
      || typeof nonce !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(nonce)
      || typeof timestamp !== 'string' || !/^\d{13}$/.test(timestamp)
      || Math.abs(now - Number(timestamp)) > signingWindowMs
      || typeof signature !== 'string' || !/^[\da-f]{64}$/i.test(signature)
      || (!request.rawBody && (request.headers['transfer-encoding'] !== undefined
        || Number(request.headers['content-length'] ?? 0) > 0))) {
      throw new UnauthorizedException('Invalid Agent signature');
    }

    const key = keys[keyId];
    if (typeof key?.secret !== 'string' || !key.secret.trim()) {
      throw new UnauthorizedException('Invalid Agent signature');
    }
    const expected = agentRequestSignature(
      key.secret, keyId, request.method, request.originalUrl, timestamp, nonce, request.rawBody ?? '',
    );
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) {
      throw new UnauthorizedException('Invalid Agent signature');
    }

    for (const [id, expires] of this.seenNonces) {
      if (expires >= now) break;
      this.seenNonces.delete(id);
    }
    const nonceKey = JSON.stringify([keyId, nonce]);
    if (this.seenNonces.has(nonceKey)) {
      throw new UnauthorizedException('Agent signature nonce was already used');
    }
    this.seenNonces.set(nonceKey, now + signingWindowMs * 2);
    request.agentRunAccess = { scope: key.scope || keyId, agents: key.agents };
  }
}
