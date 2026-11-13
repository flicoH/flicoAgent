import { ArgumentsHost, Catch, HttpException, HttpStatus } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import { ConfigService } from '../../config/config.service';
import { LoggerProvider } from '../../extend/logger.provider';

@Catch()
export class HttpExceptionFilter extends BaseExceptionFilter {
  constructor(
    private readonly config: ConfigService,
    private readonly adapterHost: HttpAdapterHost,
    private readonly logger: LoggerProvider,
  ) {
    super(adapterHost.httpAdapter);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const message = exception !== null && typeof exception === 'object' && 'message' in exception
      ? String(exception.message)
      : '';
    const templateNotFound = message.includes('template not found');

    if (!templateNotFound && exception instanceof HttpException && exception.getStatus() < 500) {
      super.catch(exception, host);
      return;
    }

    this.logger.logger.error('[-- exception --]:', exception);
    const response = host.switchToHttp().getResponse();
    const { httpAdapter } = this.adapterHost;
    if (httpAdapter.isHeadersSent(response)) {
      httpAdapter.end(response);
      return;
    }

    if (templateNotFound) {
      httpAdapter.redirect(response, HttpStatus.FOUND, this.config.get<string>('homePage') ?? '/');
      return;
    }

    httpAdapter.reply(response, {
      success: false,
      code: 50000,
      message: '网络错误，请稍候重试',
    }, HttpStatus.OK);
  }
}
