import { Injectable } from '@nestjs/common';
import knex from 'knex';
import { ConfigService } from '../config/config.service';

@Injectable()
export class DatabaseProvider {
  readonly knex?: knex;

  constructor(config: ConfigService) {
    const db = config.get<knex.Config>('db');
    if (db) {
      this.knex = knex(db);
    }
  }
}
