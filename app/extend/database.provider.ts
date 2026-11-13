import { Injectable } from '@nestjs/common';
import knex from 'knex';
import { ConfigService } from '../config/config.service';

@Injectable()
export class DatabaseProvider {
  readonly knex?: knex;

  constructor(config: ConfigService) {
    const db = config.get<knex.Config>('db');
    if (db) {
      // 兼容旧配置中的 mysql 别名，框架随包提供 mysql2 驱动。
      this.knex = knex(db.client === 'mysql' ? { ...db, client: 'mysql2' } : db);
    }
  }
}
