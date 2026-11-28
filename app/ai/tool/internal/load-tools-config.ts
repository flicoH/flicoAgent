import type {
  AiToolsOptions,
  HttpToolOptions,
  SqlToolOptions,
} from '../../../config/bootstrap-options';
import { ConfigService } from '../../../config/config.service';

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
export const DEFAULT_TOOL_MAX_OUTPUT_CHARS = 16_000;

export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
export const DEFAULT_HTTP_MAX_RESPONSE_BYTES = 262_144;
export const DEFAULT_HTTP_MAX_REDIRECTS = 3;
export const DEFAULT_HTTP_ALLOWED_METHODS = ['GET', 'HEAD'] as const;

export const DEFAULT_SQL_MAX_ROWS = 100;
export const HARD_MAX_SQL_ROWS = 1000;
export const DEFAULT_SQL_TIMEOUT_MS = 10_000;

export interface ResolvedToolGuardOptions {
  timeoutMs: number;
  maxOutputChars: number;
}

export interface ResolvedHttpToolOptions {
  enabled: boolean;
  approval?: 'required';
  allowedHosts: string[];
  allowedMethods: string[];
  allowPrivateNetworks: boolean;
  timeoutMs: number;
  maxResponseBytes: number;
  allowedHeaders?: string[];
  defaultHeaders: Record<string, string>;
  maxRedirects: number;
}

export interface ResolvedSqlToolOptions {
  enabled: boolean;
  approval?: 'required';
  allowedTables: string[];
  deniedTables: string[];
  maxRows: number;
  timeoutMs: number;
  executor?: SqlToolOptions['executor'];
}

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

function parseNonNegativeInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

function normalizeStringList(value: unknown, transform: (item: string) => string = item => item): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const unique = new Set<string>();
  for (const raw of value) {
    if (typeof raw === 'string' && raw.trim()) {
      unique.add(transform(raw.trim()));
    }
  }
  return [...unique];
}

export function readToolsConfig(config?: ConfigService): AiToolsOptions {
  if (!config) {
    return {};
  }
  const direct = config.get<AiToolsOptions>('ai.tools');
  if (direct && typeof direct === 'object') {
    return direct;
  }
  const ai = config.get<{ tools?: AiToolsOptions }>('ai');
  return ai?.tools && typeof ai.tools === 'object' ? ai.tools : {};
}

export function resolveToolGuardOptions(
  config?: ConfigService,
  capability?: { timeoutMs?: number; maxOutputChars?: number },
  overrides?: { timeoutMs?: number; maxOutputChars?: number },
): ResolvedToolGuardOptions {
  const globalCfg = readToolsConfig(config);
  const timeoutMs = parsePositiveInt(overrides?.timeoutMs)
    ?? parsePositiveInt(capability?.timeoutMs)
    ?? parsePositiveInt(globalCfg.timeoutMs)
    ?? DEFAULT_TOOL_TIMEOUT_MS;
  const maxOutputChars = parsePositiveInt(overrides?.maxOutputChars)
    ?? parsePositiveInt(capability?.maxOutputChars)
    ?? parsePositiveInt(globalCfg.maxOutputChars)
    ?? DEFAULT_TOOL_MAX_OUTPUT_CHARS;

  return { timeoutMs, maxOutputChars };
}

export function resolveHttpToolOptions(config?: ConfigService): ResolvedHttpToolOptions {
  const raw = readToolsConfig(config).http as HttpToolOptions | undefined;
  const allowedHosts = normalizeStringList(raw?.allowedHosts, host => host.toLowerCase());
  const rawMethods = normalizeStringList(raw?.allowedMethods, method => method.toUpperCase());
  const allowedMethods = rawMethods.length > 0 ? rawMethods : [...DEFAULT_HTTP_ALLOWED_METHODS];
  const allowedHeaders = Array.isArray(raw?.allowedHeaders)
    ? normalizeStringList(raw.allowedHeaders, header => header.toLowerCase())
    : undefined;

  const defaultHeaders: Record<string, string> = {};
  if (raw?.defaultHeaders && typeof raw.defaultHeaders === 'object' && !Array.isArray(raw.defaultHeaders)) {
    for (const [key, val] of Object.entries(raw.defaultHeaders)) {
      if (key.trim() && typeof val === 'string') {
        defaultHeaders[key.trim()] = val;
      }
    }
  }

  return {
    enabled: allowedHosts.length > 0,
    ...(raw?.approval === 'required' ? { approval: 'required' as const } : {}),
    allowedHosts,
    allowedMethods,
    allowPrivateNetworks: raw?.allowPrivateNetworks === true,
    timeoutMs: parsePositiveInt(raw?.timeoutMs) ?? DEFAULT_HTTP_TIMEOUT_MS,
    maxResponseBytes: parsePositiveInt(raw?.maxResponseBytes) ?? DEFAULT_HTTP_MAX_RESPONSE_BYTES,
    ...(allowedHeaders !== undefined ? { allowedHeaders } : {}),
    defaultHeaders,
    maxRedirects: parseNonNegativeInt(raw?.maxRedirects) ?? DEFAULT_HTTP_MAX_REDIRECTS,
  };
}

export function resolveSqlToolOptions(config?: ConfigService): ResolvedSqlToolOptions {
  const raw = readToolsConfig(config).sql as SqlToolOptions | undefined;
  const configuredMaxRows = parsePositiveInt(raw?.maxRows) ?? DEFAULT_SQL_MAX_ROWS;
  return {
    enabled: raw?.enabled === true,
    ...(raw?.approval === 'required' ? { approval: 'required' as const } : {}),
    allowedTables: normalizeStringList(raw?.allowedTables, table => table.toLowerCase()),
    deniedTables: normalizeStringList(raw?.deniedTables, table => table.toLowerCase()),
    maxRows: Math.min(configuredMaxRows, HARD_MAX_SQL_ROWS),
    timeoutMs: parsePositiveInt(raw?.timeoutMs) ?? DEFAULT_SQL_TIMEOUT_MS,
    ...(typeof raw?.executor === 'function' ? { executor: raw.executor } : {}),
  };
}
