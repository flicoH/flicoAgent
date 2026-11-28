import { ConfigService } from '../../../config/config.service';
import { DatabaseProvider } from '../../../extend/database.provider';
import {
  HARD_MAX_SQL_ROWS,
  resolveSqlToolOptions,
} from '../internal/load-tools-config';
import type { BuiltinToolDeps, ToolDefinition } from '../tool.interface';

interface SqlQueryInput {
  sql: string;
  params?: Array<string | number | boolean | null>;
  maxRows?: number;
}

export interface SqlValidationOptions {
  allowedTables?: string[];
  deniedTables?: string[];
}

export interface SqlValidationResult {
  valid: boolean;
  normalizedSql?: string;
  tables?: string[];
  reason?: string;
}

const ALLOWED_LEADING_KEYWORDS = new Set([
  'SELECT',
  'WITH',
  'SHOW',
  'DESCRIBE',
  'DESC',
  'EXPLAIN',
]);

const FORBIDDEN_KEYWORDS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'REPLACE',
  'MERGE',
  'GRANT',
  'REVOKE',
  'CALL',
  'EXEC',
  'EXECUTE',
  'LOAD',
  'OUTFILE',
  'DUMPFILE',
  'LOCK',
  'UNLOCK',
  'SET',
  'FLUSH',
  'RESET',
  'PURGE',
  'HANDLER',
  'PREPARE',
  'DEALLOCATE',
  'DO',
  'RENAME',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'BEGIN',
  'START',
  'INTO',
  'SLEEP',
  'BENCHMARK',
  'PG_SLEEP',
  'WAITFOR',
]);

const TABLE_CLAUSE_TERMINATORS = new Set([
  'WHERE',
  'GROUP',
  'HAVING',
  'ORDER',
  'LIMIT',
  'OFFSET',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'JOIN',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'CROSS',
  'NATURAL',
  'STRAIGHT_JOIN',
  'ON',
  'USING',
  'WINDOW',
  'FETCH',
  'FOR',
]);

interface SqlToken {
  type: 'word' | 'quoted_ident' | 'symbol';
  value: string;
  upper: string;
}

function unquoteIdentifier(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('`') && trimmed.endsWith('`'))
    || (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function tokenizeSql(sql: string): { tokens?: SqlToken[]; error?: string } {
  const tokens: SqlToken[] = [];
  let index = 0;

  while (index < sql.length) {
    const ch = sql[index];
    const next = sql[index + 1];

    if (/\s/.test(ch)) {
      index++;
      continue;
    }

    // 禁止注释以防绕过只读检查
    if ((ch === '-' && next === '-') || ch === '#' || (ch === '/' && next === '*')) {
      return { error: 'SQL comments are not allowed in read-only sql-query' };
    }

    // 单引号字符串字面量：整体跳过（保留内容安全隔离）
    if (ch === '\'') {
      index++;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === '\\' && index + 1 < sql.length) {
          index += 2;
          continue;
        }
        if (sql[index] === '\'') {
          if (sql[index + 1] === '\'') {
            index += 2;
            continue;
          }
          index++;
          closed = true;
          break;
        }
        index++;
      }
      if (!closed) {
        return { error: 'Unterminated string literal in SQL query' };
      }
      tokens.push({ type: 'symbol', value: '\'\'', upper: '\'\'' });
      continue;
    }

    // 反引号或双引号标识符
    if (ch === '`' || ch === '"') {
      const quote = ch;
      let end = index + 1;
      let closed = false;
      let value = '';
      while (end < sql.length) {
        if (sql[end] === quote) {
          if (sql[end + 1] === quote) {
            value += quote;
            end += 2;
            continue;
          }
          closed = true;
          end++;
          break;
        }
        value += sql[end];
        end++;
      }
      if (!closed) {
        return { error: 'Unterminated quoted identifier in SQL query' };
      }
      tokens.push({ type: 'quoted_ident', value, upper: value.toUpperCase() });
      index = end;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end])) {
        end++;
      }
      const value = sql.slice(index, end);
      tokens.push({ type: 'word', value, upper: value.toUpperCase() });
      index = end;
      continue;
    }

    tokens.push({ type: 'symbol', value: ch, upper: ch });
    index++;
  }

  return { tokens };
}

function readTableIdentifier(tokens: SqlToken[], start: number): { table: string; nextIndex: number } | null {
  const first = tokens[start];
  if (!first || (first.type !== 'word' && first.type !== 'quoted_ident')) {
    return null;
  }
  if (first.type === 'word' && TABLE_CLAUSE_TERMINATORS.has(first.upper)) {
    return null;
  }
  let table = unquoteIdentifier(first.value);
  let nextIndex = start + 1;
  if (tokens[nextIndex]?.value === '.' && tokens[nextIndex + 1]
    && (tokens[nextIndex + 1].type === 'word' || tokens[nextIndex + 1].type === 'quoted_ident')) {
    table = `${table}.${unquoteIdentifier(tokens[nextIndex + 1].value)}`;
    nextIndex += 2;
  }
  return { table: table.toLowerCase(), nextIndex };
}

function extractCteNames(tokens: SqlToken[]): Set<string> {
  const cteNames = new Set<string>();
  if (tokens[0]?.upper !== 'WITH') {
    return cteNames;
  }

  let index = 1;
  if (tokens[index]?.upper === 'RECURSIVE') {
    index++;
  }

  while (index < tokens.length) {
    const nameTok = tokens[index];
    if (!nameTok || (nameTok.type !== 'word' && nameTok.type !== 'quoted_ident')) {
      break;
    }
    cteNames.add(unquoteIdentifier(nameTok.value).toLowerCase());
    index++;

    // 可选列清单: cte(a, b)
    if (tokens[index]?.value === '(') {
      let depth = 1;
      index++;
      while (index < tokens.length && depth > 0) {
        if (tokens[index].value === '(') depth++;
        else if (tokens[index].value === ')') depth--;
        index++;
      }
    }

    if (tokens[index]?.upper !== 'AS') {
      break;
    }
    index++;

    // 可选 MATERIALIZED / NOT MATERIALIZED
    if (tokens[index]?.upper === 'NOT' && tokens[index + 1]?.upper === 'MATERIALIZED') {
      index += 2;
    } else if (tokens[index]?.upper === 'MATERIALIZED') {
      index++;
    }

    if (tokens[index]?.value !== '(') {
      break;
    }
    let depth = 1;
    index++;
    while (index < tokens.length && depth > 0) {
      if (tokens[index].value === '(') depth++;
      else if (tokens[index].value === ')') depth--;
      index++;
    }

    if (tokens[index]?.value === ',') {
      index++;
      continue;
    }
    break;
  }

  return cteNames;
}

function extractReferencedTables(tokens: SqlToken[]): string[] {
  const cteNames = extractCteNames(tokens);
  const tables = new Set<string>();

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type !== 'word') continue;

    if (tok.upper === 'FROM' || tok.upper === 'JOIN' || tok.upper === 'STRAIGHT_JOIN') {
      let cursor = i + 1;
      while (cursor < tokens.length) {
        if (tokens[cursor]?.value === '(') {
          break;
        }
        const parsed = readTableIdentifier(tokens, cursor);
        if (!parsed) {
          break;
        }
        const bare = parsed.table.includes('.') ? parsed.table.split('.').at(-1)! : parsed.table;
        if (!cteNames.has(parsed.table) && !cteNames.has(bare)) {
          tables.add(parsed.table);
        }
        cursor = parsed.nextIndex;

        // 跳过表别名（可选 AS alias 或裸 alias）
        if (tokens[cursor]?.upper === 'AS' && tokens[cursor + 1]) {
          cursor += 2;
        } else if (
          tokens[cursor]
          && (tokens[cursor].type === 'word' || tokens[cursor].type === 'quoted_ident')
          && !TABLE_CLAUSE_TERMINATORS.has(tokens[cursor].upper)
        ) {
          cursor++;
        }

        // 支持 FROM t1, t2 逗号连接
        if (tok.upper === 'FROM' && tokens[cursor]?.value === ',') {
          cursor++;
          continue;
        }
        break;
      }
    }
  }

  return [...tables];
}

function matchesTableList(table: string, list: string[]): boolean {
  const normalized = table.toLowerCase();
  const bare = normalized.includes('.') ? normalized.split('.').at(-1)! : normalized;
  return list.includes(normalized) || list.includes(bare);
}

/**
 * 校验只读 SQL 语句安全性与表级访问控制。
 */
export function validateReadOnlySql(
  rawSql: string,
  options: SqlValidationOptions = {},
): SqlValidationResult {
  if (typeof rawSql !== 'string' || !rawSql.trim()) {
    return { valid: false, reason: 'SQL query must be a non-empty string' };
  }

  const trimmed = rawSql.trim();
  const tokenized = tokenizeSql(trimmed);
  if (tokenized.error || !tokenized.tokens?.length) {
    return { valid: false, reason: tokenized.error ?? 'SQL query is empty' };
  }

  const tokens = tokenized.tokens;

  // 允许且仅允许末尾单个分号，禁止多语句拼接
  let effectiveTokens = tokens;
  if (tokens.at(-1)?.value === ';') {
    effectiveTokens = tokens.slice(0, -1);
  }
  if (effectiveTokens.some(token => token.value === ';')) {
    return { valid: false, reason: 'Multiple SQL statements are not allowed' };
  }
  if (effectiveTokens.length === 0) {
    return { valid: false, reason: 'SQL query is empty' };
  }

  const first = effectiveTokens[0];
  if (first.type !== 'word' || !ALLOWED_LEADING_KEYWORDS.has(first.upper)) {
    return {
      valid: false,
      reason: `Only read-only statements (${[...ALLOWED_LEADING_KEYWORDS].join(', ')}) are allowed`,
    };
  }

  for (let i = 0; i < effectiveTokens.length; i++) {
    const token = effectiveTokens[i];
    if (token.type === 'word' && FORBIDDEN_KEYWORDS.has(token.upper)) {
      return {
        valid: false,
        reason: `Forbidden SQL keyword "${token.upper}" is not allowed in read-only sql-query`,
      };
    }
    if (token.type === 'word' && token.upper === 'FOR') {
      const nextUpper = effectiveTokens[i + 1]?.upper;
      if (nextUpper === 'UPDATE' || nextUpper === 'SHARE') {
        return {
          valid: false,
          reason: `Row locking clause "FOR ${nextUpper}" is not allowed in read-only sql-query`,
        };
      }
    }
  }

  const tables = extractReferencedTables(effectiveTokens);
  const deniedTables = (options.deniedTables ?? []).map(t => t.toLowerCase());
  const allowedTables = (options.allowedTables ?? []).map(t => t.toLowerCase());

  if (deniedTables.length > 0) {
    for (const table of tables) {
      if (matchesTableList(table, deniedTables)) {
        return { valid: false, reason: `Access to table "${table}" is denied` };
      }
    }
  }

  if (allowedTables.length > 0) {
    for (const table of tables) {
      if (!matchesTableList(table, allowedTables)) {
        return { valid: false, reason: `Table "${table}" is not in ai.tools.sql.allowedTables` };
      }
    }
  }

  const normalizedSql = trimmed.replace(/;\s*$/, '');
  return { valid: true, normalizedSql, tables };
}

function unwrapQueryRows(result: unknown): unknown[] {
  if (Array.isArray(result)) {
    // mysql2 via knex.raw 返回 [rows, fields]
    if (result.length >= 1 && Array.isArray(result[0])) {
      return result[0] as unknown[];
    }
    return result;
  }
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: unknown[] }).rows;
  }
  return [];
}

/**
 * 框架内置工具：受控只读 SQL 查询工具 (sql-query)
 *
 * 【安全防线】
 * 1. 默认关闭，需在配置中显式设置 ai.tools.sql.enabled: true；
 * 2. 严格只读 SQL 词法校验，拦截多语句、注释绕过及所有写/DDL/管理/锁/延时关键字；
 * 3. 支持 allowedTables 白名单与 deniedTables 黑名单（自动识别并排除 CTE 别名）；
 * 4. 强制行数截断（默认 100，硬上限 1000），配合 ExecutorService 超时与输出截断双重兜底。
 */
export default function createSqlQueryTool(deps: BuiltinToolDeps): ToolDefinition {
  const getConfig = (): ConfigService | undefined => {
    try {
      return deps.moduleRef.get(ConfigService, { strict: false });
    } catch {
      return undefined;
    }
  };

  const initialOptions = resolveSqlToolOptions(getConfig());

  return {
    name: 'sql-query',
    ...(initialOptions.approval ? { approval: initialOptions.approval } : {}),
    timeoutMs: initialOptions.timeoutMs,
    description: '执行受控只读 SQL 查询（仅允许单条 SELECT/WITH/SHOW/DESCRIBE/EXPLAIN，受表权限与行数上限保护）。',
    inputSchema: {
      type: 'object',
      required: ['sql'],
      additionalProperties: false,
      properties: {
        sql: { type: 'string', minLength: 1, description: '单条只读 SQL 语句（支持 ? 占位符）' },
        params: {
          type: 'array',
          items: { type: ['string', 'number', 'boolean', 'null'] },
          description: '可选参数化查询绑定值',
        },
        maxRows: {
          type: 'integer',
          minimum: 1,
          maximum: HARD_MAX_SQL_ROWS,
          description: '可选最大返回行数（不会超过服务端 ai.tools.sql.maxRows 上限）',
        },
      },
    },
    source: 'builtin',
    async execute(rawInput: unknown, ctx?: Record<string, unknown>): Promise<unknown> {
      const options = resolveSqlToolOptions(getConfig());
      if (!options.enabled) {
        throw new Error('SQL tool is disabled: set ai.tools.sql.enabled = true to enable read-only queries');
      }

      const input = rawInput as SqlQueryInput;
      const validation = validateReadOnlySql(input.sql, {
        allowedTables: options.allowedTables,
        deniedTables: options.deniedTables,
      });
      if (!validation.valid || !validation.normalizedSql) {
        throw new Error(validation.reason ?? 'Invalid read-only SQL query');
      }

      const params = Array.isArray(input.params) ? input.params : [];
      const effectiveMaxRows = Math.min(
        typeof input.maxRows === 'number' && Number.isSafeInteger(input.maxRows) && input.maxRows > 0
          ? input.maxRows
          : options.maxRows,
        options.maxRows,
        HARD_MAX_SQL_ROWS,
      );
      const signal = ctx?.signal instanceof AbortSignal ? ctx.signal : undefined;

      let rows: unknown[];
      if (options.executor) {
        const raw = await options.executor(validation.normalizedSql, params, signal);
        rows = unwrapQueryRows(raw);
      } else {
        let dbProvider: DatabaseProvider | undefined;
        try {
          dbProvider = deps.moduleRef.get(DatabaseProvider, { strict: false });
        } catch {
          dbProvider = undefined;
        }
        if (!dbProvider?.knex) {
          throw new Error('Database connection is not configured (db or ai.tools.sql.executor is required)');
        }
        const raw = await dbProvider.knex.raw(validation.normalizedSql, params as any[]);
        rows = unwrapQueryRows(raw);
      }

      const truncated = rows.length > effectiveMaxRows;
      const sliced = truncated ? rows.slice(0, effectiveMaxRows) : rows;
      return {
        rows: sliced,
        rowCount: sliced.length,
        truncated,
      };
    },
  };
}
