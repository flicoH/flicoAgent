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
    this.logger.logger.info(`[ViewController] query: ${JSON.stringify({ proj_key: projKey })}`);
    this.logger.logger.info(`[ViewController] params: ${JSON.stringify({ page })}`);
    return this.templates.render(`./dist/entry.${page}.tpl`, {
      projKey,
      name: this.config.get('name'),
      env: process.env._ENV ?? process.env.__ENV ?? 'local',
      options: JSON.stringify({
        ...this.config.getBootstrapOptions(),
        agentConfig: this.config.get('agentConfig') ?? this.config.get('ai.agentConfig'),
      }),
    });
  }
}
