import { Injectable } from '@nestjs/common';
import { configure, getLogger, Logger } from 'log4js';

@Injectable()
export class LoggerProvider {
  readonly logger: Console | Logger;

  constructor() {
    if ((process.env._ENV ?? process.env.__ENV ?? 'local') === 'local') {
      this.logger = console;
      return;
    }

    configure({
      appenders: {
        console: {
          type: 'console',
        },
        dateFile: {
          type: 'dateFile',
          filename: './logs/application.log',
          pattern: 'yyyy-MM-dd.log',
          alwaysIncludePattern: true,
          daysToKeep: 30,
          numBackups: 3,
        },
      },
      categories: {
        default: {
          appenders: ['console', 'dateFile'],
          level: 'trace',
        },
      },
    });
    this.logger = getLogger('dateFile');
  }
}
