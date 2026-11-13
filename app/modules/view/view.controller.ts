import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { Environment, FileSystemLoader } from 'nunjucks';
import { resolve } from 'node:path';
import { ConfigService } from '../../config/config.service';
import { LoggerProvider } from '../../extend/logger.provider';

@Controller('view')
export class ViewController {
  private readonly templates = new Environment(
    new FileSystemLoader(resolve(process.cwd(), 'app/public'), { noCache: true }),
    { autoescape: true, trimBlocks: true },
  );

  constructor(
    private readonly config: ConfigService,
    private readonly logger: LoggerProvider,
  ) {}

  @Get([':page', ':page/{*path}'])
  @Header('Content-Type', 'text/html; charset=utf-8')
  renderPage(@Param('page') page: string, @Query('proj_key') projKey?: string): string {
    // AI 签名密钥和授权配置仅在服务端使用，启动参数也可能包含这些字段。
    const { ai: _ai, ...pageOptions } = this.config.getBootstrapOptions() as Record<string, unknown>;
    this.logger.logger.info(`[ViewController] query: ${JSON.stringify({ proj_key: projKey })}`);
    this.logger.logger.info(`[ViewController] params: ${JSON.stringify({ page })}`);
    return this.templates.render(`./dist/entry.${page}.tpl`, {
      projKey,
      name: this.config.get('name'),
      env: process.env._ENV ?? process.env.__ENV ?? 'local',
      options: JSON.stringify({
        ...pageOptions,
        agentConfig: this.config.get('agentConfig') ?? this.config.get('ai.agentConfig'),
      }),
    });
  }
}
