import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { NonceStore, NonceStoreOptions, resolveNonceStore } from '../../ai/access/nonce-store';
import { agentRequestSignature } from '../../ai/access/request-signature';
import type { AgentRunAccess } from '../../ai/contracts';
import { ConfigService } from '../../config/config.service';
import { DatabaseProvider } from '../../extend/database.provider';

const agentRoute = /^\/api\/ai\/(?:agent\/(?:run(?:\/stream)?|runs(?:\/[^/]+(?:\/(?:events|cancel|approval))?)?)|trace\/[^/]+(?:\/usage)?|chat(?:\/stream)?|skill\/[^/]+\/invoke)\/?$/i;
const ragRoute = /^\/api\/ai\/rag\/(?:documents|rebuild|preview|chunk|wiki\/(?:pages|page))\/?$/i;
const signingWindowMs = 5 * 60 * 1000;
const REQUEST_VERIFIED = Symbol('ApiSignGuardVerified');

interface AgentAccessConfig {
  keys?: Record<string, AgentRunAccess & { secret: string }>;
  authorize?: (request: Request) => AgentRunAccess | null | Promise<AgentRunAccess | null>;
  nonceStore?: NonceStoreOptions;
}

@Injectable()
export class ApiSignGuard implements CanActivate {
  private nonceStorePromise?: Promise<NonceStore>;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly database?: DatabaseProvider,
  ) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    const request = context.switchToHttp().getRequest<RawBodyRequest<Request> & { [REQUEST_VERIFIED]?: boolean }>();
    if (request[REQUEST_VERIFIED]) {
      return true;
    }

    const ragManagement = ragRoute.test(request.path);
    if (ragManagement || agentRoute.test(request.path)) {
      const access = this.config.get<AgentAccessConfig>('ai.access');
      if (request.headers['x-agent-key-id'] !== undefined || request.headers['x-agent-nonce'] !== undefined) {
        return this.verifyAgentSignature(request, access?.keys).then(() => {
          request[REQUEST_VERIFIED] = true;
          return true;
        });
      }
      if (access?.authorize) {
        try {
          this.verifyLegacySignature(request);
        } catch (error) {
          if (ragManagement) throw new UnauthorizedException('RAG signing credentials required');
          throw error;
        }
        return this.authorizeSession(request, access.authorize).then((ok) => {
          if (ok) request[REQUEST_VERIFIED] = true;
          return ok;
        });
      }
      if (ragManagement || (access?.keys && Object.keys(access.keys).length > 0)) {
        throw new UnauthorizedException('Agent signing credentials required');
      }
    }
    if (!request.path.startsWith('/api/')) {
      return true;
    }
    const whiteList = this.config.get<string[]>('apiSignVerify.whiteList') ?? [];
    if (whiteList.includes(request.path)) {
      request[REQUEST_VERIFIED] = true;
      return true;
    }

    this.verifyLegacySignature(request);
    request[REQUEST_VERIFIED] = true;
    return true;
  }

  private getNonceStore(): Promise<NonceStore> {
    if (!this.nonceStorePromise) {
      this.nonceStorePromise = resolveNonceStore(this.config, this.database?.knex);
    }
    return this.nonceStorePromise;
  }

  private verifyLegacySignature(request: Request): void {
    const { s_sign: sign, s_t: st } = request.headers;
    const signKey = 'klx05hb3n1c9ujp8uhxbs2ikkiowp212';
    const signature = createHash('md5').update(`${signKey}_${st}`).digest('hex').toLowerCase();
    const numericSt = typeof st === 'string' && /^\d+$/.test(st) ? Number(st) : Number.NaN;
    if (
      typeof sign !== 'string' || typeof st !== 'string' || !sign || !st ||
      !Number.isFinite(numericSt) ||
      signature !== sign.toLowerCase() || Math.abs(Date.now() - numericSt) > 600000
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

  private async verifyAgentSignature(request: RawBodyRequest<Request>, keys?: AgentAccessConfig['keys']): Promise<void> {
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

    const nonceStore = await this.getNonceStore();
    const nonceKey = JSON.stringify([keyId, nonce]);
    const accepted = await nonceStore.consume(nonceKey, signingWindowMs * 2);
    if (!accepted) {
      throw new UnauthorizedException('Agent signature nonce was already used');
    }

    request.agentRunAccess = {
      scope: key.scope || keyId,
      agents: key.agents,
      ...(key.skills ? { skills: key.skills } : {}),
      ...(key.ragRead === true ? { ragRead: true } : {}),
      ...(key.ingest === true ? { ingest: true } : {}),
      ...(key.approve === true ? { approve: true } : {}),
    };
  }
}
