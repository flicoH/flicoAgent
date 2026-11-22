import { Injectable, OnModuleDestroy } from '@nestjs/common';
import knex from 'knex';
import { ConfigService } from '../config/config.service';

@Injectable()
export class DatabaseProvider implements OnModuleDestroy {
  readonly knex?: knex;

  constructor(config: ConfigService) {
    const db = config.get<knex.Config>('db');
    if (db) {
      this.knex = knex(db);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.knex?.destroy();
  }
}
