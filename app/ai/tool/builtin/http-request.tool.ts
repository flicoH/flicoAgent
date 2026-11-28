import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ConfigService } from '../../../config/config.service';
import { resolveHttpToolOptions, type ResolvedHttpToolOptions } from '../internal/load-tools-config';
import type { BuiltinToolDeps, ToolDefinition } from '../tool.interface';

interface HttpRequestInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
}

const FORBIDDEN_REQUEST_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'upgrade',
  'te',
]);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function normalizeHostname(hostname: string): string {
  const lower = hostname.trim().toLowerCase();
  if (lower.startsWith('[') && lower.endsWith(']')) {
    return lower.slice(1, -1);
  }
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

export function isHostAllowed(hostname: string, allowedHosts: string[]): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized || allowedHosts.length === 0) {
    return false;
  }
  for (const rawPattern of allowedHosts) {
    const pattern = normalizeHostname(rawPattern);
    if (!pattern) continue;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // '.example.com'
      if (normalized.length > suffix.length && normalized.endsWith(suffix)) {
        return true;
      }
    } else if (normalized === pattern) {
      return true;
    }
  }
  return false;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(part => Number(part));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 & 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // multicast & reserved
  return false;
}

export function isPrivateIpAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    return isPrivateIpv4(normalized);
  }
  if (ipVersion === 6) {
    if (normalized === '::' || normalized === '::1') {
      return true;
    }
    // IPv4-mapped IPv6: ::ffff:127.0.0.1 或 ::ffff:7f00:1
    const v4MappedDotted = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4MappedDotted) {
      return isPrivateIpv4(v4MappedDotted[1]);
    }
    const v4MappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (v4MappedHex) {
      const hi = parseInt(v4MappedHex[1], 16);
      const lo = parseInt(v4MappedHex[2], 16);
      return isPrivateIpv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
    }
    const firstHextet = parseInt(normalized.split(':')[0] || '0', 16);
    // fc00::/7 (Unique Local), fe80::/10 (Link Local), ff00::/8 (Multicast)
    if ((firstHextet & 0xfe00) === 0xfc00) return true;
    if ((firstHextet & 0xffc0) === 0xfe80) return true;
    if ((firstHextet & 0xff00) === 0xff00) return true;
    return false;
  }
  return false;
}

function isLocalHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.local')
    || normalized.endsWith('.internal');
}

async function validateTargetUrl(
  rawUrl: string,
  options: ResolvedHttpToolOptions,
  resolveDns: typeof lookup = lookup,
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: "${rawUrl}"`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Protocol "${parsed.protocol}" is not allowed; only http and https are permitted`);
  }

  if (parsed.username || parsed.password) {
    throw new Error('URLs with embedded credentials are not allowed');
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (!isHostAllowed(hostname, options.allowedHosts)) {
    throw new Error(`Host "${hostname}" is not in ai.tools.http.allowedHosts`);
  }

  if (!options.allowPrivateNetworks) {
    if (isLocalHostname(hostname)) {
      throw new Error(`Access to private/local host "${hostname}" is blocked`);
    }
    if (isIP(hostname)) {
      if (isPrivateIpAddress(hostname)) {
        throw new Error(`Access to private IP "${hostname}" is blocked`);
      }
    } else {
      let records: Array<{ address: string }>;
      try {
        records = await resolveDns(hostname, { all: true });
      } catch (error) {
        throw new Error(`Failed to resolve host "${hostname}": ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!records.length) {
        throw new Error(`Host "${hostname}" did not resolve to any IP address`);
      }
      for (const record of records) {
        if (isPrivateIpAddress(record.address)) {
          throw new Error(`Host "${hostname}" resolved to private IP "${record.address}" and is blocked`);
        }
      }
    }
  }

  return parsed;
}

function buildRequestHeaders(
  inputHeaders: Record<string, string> | undefined,
  options: ResolvedHttpToolOptions,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (inputHeaders && typeof inputHeaders === 'object') {
    for (const [rawKey, rawVal] of Object.entries(inputHeaders)) {
      const key = rawKey.trim();
      const lower = key.toLowerCase();
      if (!key || typeof rawVal !== 'string') continue;
      if (FORBIDDEN_REQUEST_HEADERS.has(lower)) {
        throw new Error(`Header "${key}" is forbidden`);
      }
      if (options.allowedHeaders && !options.allowedHeaders.includes(lower)) {
        throw new Error(`Header "${key}" is not allowed`);
      }
      headers[key] = rawVal;
    }
  }

  // 服务端 defaultHeaders 覆盖在后，避免模型伪造或篡改内部鉴权头
  for (const [key, val] of Object.entries(options.defaultHeaders)) {
    headers[key] = val;
  }
  return headers;
}

async function readResponseWithLimit(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    return { text: '', truncated: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      if (total + value.byteLength > maxBytes) {
        const remaining = maxBytes - total;
        if (remaining > 0) {
          chunks.push(value.subarray(0, remaining));
          total += remaining;
        }
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }

      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const buffer = Buffer.concat(chunks.map(chunk => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)), total);
  return { text: buffer.toString('utf8'), truncated };
}

function collectSafeResponseHeaders(headers: Headers): Record<string, string> {
  const safe: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === 'set-cookie') {
      return;
    }
    safe[lower] = value;
  });
  return safe;
}

/**
 * 框架内置工具：受控 HTTP 请求工具 (http-request)
 *
 * 【安全防线】
 * 1. 默认拒绝（Default-Deny）：必须配置 ai.tools.http.allowedHosts 白名单后方可调用；
 * 2. 方法白名单：默认仅允许 GET / HEAD；
 * 3. SSRF 防护：默认拦截 localhost、私网/回环/链路本地 IP 及解析到私网地址的域名；
 * 4. 重定向二次校验：手动跟随重定向，每跳均重新校验白名单与 SSRF，跨源重定向剥离敏感头；
 * 5. 体积与超时防护：按 maxResponseBytes 流式读取并截断，自动联动 ctx.signal 与 timeoutMs。
 */
export default function createHttpRequestTool(deps: BuiltinToolDeps): ToolDefinition {
  const getConfig = (): ConfigService | undefined => {
    try {
      return deps.moduleRef.get(ConfigService, { strict: false });
    } catch {
      return undefined;
    }
  };

  const initialOptions = resolveHttpToolOptions(getConfig());

  return {
    name: 'http-request',
    ...(initialOptions.approval ? { approval: initialOptions.approval } : {}),
    timeoutMs: initialOptions.timeoutMs,
    description: '向经 ai.tools.http.allowedHosts 白名单授权的外部或内部 HTTP 端点发起受控请求。',
    inputSchema: {
      type: 'object',
      required: ['url'],
      additionalProperties: false,
      properties: {
        url: { type: 'string', minLength: 1, description: '完整的 http:// 或 https:// 请求地址' },
        method: { type: 'string', description: 'HTTP 方法，默认 GET（受 ai.tools.http.allowedMethods 约束）' },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: '可选请求头键值对',
        },
        query: {
          type: 'object',
          additionalProperties: { type: ['string', 'number', 'boolean'] },
          description: '可选 URL 查询参数',
        },
        body: {
          description: '可选请求体（对象将序列化为 JSON，仅允许非 GET/HEAD 方法）',
        },
      },
    },
    source: 'builtin',
    async execute(rawInput: unknown, ctx?: Record<string, unknown>): Promise<unknown> {
      const options = resolveHttpToolOptions(getConfig());
      if (!options.enabled) {
        throw new Error('HTTP tool is disabled: configure ai.tools.http.allowedHosts first');
      }

      const input = rawInput as HttpRequestInput;
      const method = (input.method?.trim() || 'GET').toUpperCase();
      if (!options.allowedMethods.includes(method)) {
        throw new Error(`HTTP method "${method}" is not allowed (allowed: ${options.allowedMethods.join(', ')})`);
      }

      let currentUrl = await validateTargetUrl(input.url, options);
      if (input.query && typeof input.query === 'object') {
        for (const [key, value] of Object.entries(input.query)) {
          if (value !== undefined && value !== null) {
            currentUrl.searchParams.set(key, String(value));
          }
        }
      }

      let currentHeaders = buildRequestHeaders(input.headers, options);
      let currentMethod = method;
      let requestBody: string | undefined;

      if (input.body !== undefined && input.body !== null) {
        if (currentMethod === 'GET' || currentMethod === 'HEAD') {
          throw new Error(`HTTP ${currentMethod} requests cannot include a request body`);
        }
        if (typeof input.body === 'string') {
          requestBody = input.body;
        } else {
          requestBody = JSON.stringify(input.body);
          const hasContentType = Object.keys(currentHeaders).some(k => k.toLowerCase() === 'content-type');
          if (!hasContentType) {
            currentHeaders['content-type'] = 'application/json';
          }
        }
      }

      const signal = ctx?.signal instanceof AbortSignal ? ctx.signal : undefined;
      let redirects = 0;

      while (true) {
        const response = await fetch(currentUrl.toString(), {
          method: currentMethod,
          headers: currentHeaders,
          body: requestBody,
          redirect: 'manual',
          signal,
        });

        if (REDIRECT_STATUSES.has(response.status)) {
          const location = response.headers.get('location');
          if (!location) {
            throw new Error(`Redirect response (${response.status}) missing Location header`);
          }
          if (redirects >= options.maxRedirects) {
            throw new Error(`Exceeded maximum redirects (${options.maxRedirects})`);
          }
          redirects++;

          const nextUrl = await validateTargetUrl(new URL(location, currentUrl).toString(), options);
          if (nextUrl.origin !== currentUrl.origin) {
            const stripped: Record<string, string> = {};
            for (const [k, v] of Object.entries(currentHeaders)) {
              const lower = k.toLowerCase();
              if (lower === 'authorization' || lower === 'cookie') continue;
              stripped[k] = v;
            }
            currentHeaders = stripped;
          }
          if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === 'POST')) {
            currentMethod = 'GET';
            requestBody = undefined;
            if (!options.allowedMethods.includes('GET')) {
              throw new Error('Redirect changed method to GET which is not allowed');
            }
          }
          await response.body?.cancel().catch(() => undefined);
          currentUrl = nextUrl;
          continue;
        }

        const safeHeaders = collectSafeResponseHeaders(response.headers);
        const { text, truncated } = currentMethod === 'HEAD'
          ? { text: '', truncated: false }
          : await readResponseWithLimit(response, options.maxResponseBytes);

        const contentType = safeHeaders['content-type'] ?? '';
        let parsedBody: unknown = text;
        if (!truncated && text && /\bjson\b/i.test(contentType)) {
          try {
            parsedBody = JSON.parse(text);
          } catch {
            parsedBody = text;
          }
        }

        return {
          status: response.status,
          ok: response.ok,
          url: currentUrl.toString(),
          headers: safeHeaders,
          body: parsedBody,
          ...(truncated ? { truncated: true } : {}),
        };
      }
    },
  };
}
