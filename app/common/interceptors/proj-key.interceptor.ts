import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Observable } from 'rxjs';

export interface ProjectRequest extends Request {
  projKey: string;
}

@Injectable()
export class ProjKeyInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<ProjectRequest>();
    if (!request.path.includes('/api/proj/')) {
      return next.handle();
    }

    const header = request.headers.proj_key;
    const projKey = Array.isArray(header) ? header[0] : header;
    if (!projKey) {
      throw new HttpException({
        success: false,
        message: 'proj_key not found',
        code: 446,
      }, HttpStatus.OK);
    }

    request.projKey = projKey;
    return next.handle();
  }
}
