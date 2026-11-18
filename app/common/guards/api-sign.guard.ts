import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ConfigService } from '../../config/config.service';

@Injectable()
export class ApiSignGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      path: string;
      headers: Record<string, string | string[] | undefined>;
    }>();

    if (!request.path.startsWith('/api/')) {
      return true;
    }
    const whiteList = this.config.get<string[]>('apiSignVerify.whiteList') ?? [];
    if (whiteList.includes(request.path)) {
      return true;
    }

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
    return true;
  }
}
