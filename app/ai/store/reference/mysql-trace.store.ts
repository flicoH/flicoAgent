import type Knex from 'knex';
import { createHash } from 'node:crypto';
import type { TraceRun } from '../../contracts';
import type { TraceListQuery, TraceStore } from '../store.interface';

const tracesTable = 'flico_ai_traces';

interface TraceRow {
  namespace_key: string;
  run_id: string;
  scope_key: string;
  agent: string;
  status: string;
  created_at: string;
  updated_at: string;
  payload: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function scopeKey(scope?: string): string {
  return sha256(scope === undefined ? '__global__' : `scope:${scope}`);
}

export class MysqlTraceStore implements TraceStore {
  private readonly namespaceKey: string;

  constructor(private readonly database: Knex, namespace = 'default') {
    this.namespaceKey = sha256(namespace);
  }

  async save(run: TraceRun): Promise<void> {
    const row: TraceRow = {
      namespace_key: this.namespaceKey,
      run_id: run.runId,
      scope_key: scopeKey(run.scope),
      agent: run.agent,
      status: run.status ?? 'succeeded',
      created_at: run.createdAt,
      updated_at: run.updatedAt,
      payload: JSON.stringify(run),
    };

    await this.database.raw(
      `INSERT INTO ?? (namespace_key, run_id, scope_key, agent, status, created_at, updated_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         scope_key = VALUES(scope_key),
         agent = VALUES(agent),
         status = VALUES(status),
         updated_at = VALUES(updated_at),
         payload = VALUES(payload)`,
      [
        tracesTable,
        row.namespace_key,
        row.run_id,
        row.scope_key,
        row.agent,
        row.status,
        row.created_at,
        row.updated_at,
        row.payload,
      ],
    );
  }

  async load(runId: string): Promise<TraceRun | null> {
    const cleanId = typeof runId === 'string' ? decodeURIComponent(runId).replace(/^\{|\}$/g, '').trim() : '';
    if (!cleanId) return null;
    const row = await this.database<TraceRow>(tracesTable)
      .where('namespace_key', this.namespaceKey)
      .where('run_id', cleanId)
      .first('payload');
    return row ? (JSON.parse(row.payload) as TraceRun) : null;
  }

  async list(query: TraceListQuery): Promise<TraceRun[]> {
    const builder = this.database<TraceRow>(tracesTable)
      .where('namespace_key', this.namespaceKey)
      .where('scope_key', scopeKey(query.scope));

    if (query.agents) {
      if (query.agents.length === 0) return [];
      builder.whereIn('agent', [...query.agents]);
    }

    const rows = await builder
      .orderBy('created_at', 'desc')
      .orderBy('run_id', 'desc')
      .offset(Math.max(0, Math.floor(query.offset || 0)))
      .limit(Math.max(0, Math.floor(query.limit || 0)))
      .select('payload');

    return rows.map(row => JSON.parse(row.payload) as TraceRun);
  }
}
