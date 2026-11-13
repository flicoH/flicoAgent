#!/usr/bin/env node
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { parseSuite, runSuite } from './run-suite';

const usage = 'Usage: flico-agent-eval --suite <cases.json> --url <service-origin> [--out <report.json>] [--timeout-ms <ms>]\n'
  + 'Set AGENT_EVAL_KEY_ID and AGENT_EVAL_SECRET to a test service signing key.';

async function main() {
  const { values } = parseArgs({ options: {
    suite: { type: 'string' }, url: { type: 'string' }, out: { type: 'string' },
    'timeout-ms': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) { process.stdout.write(usage + '\n'); return; }
  if (!values.suite || !values.url) throw new Error(usage);
  const keyId = process.env.AGENT_EVAL_KEY_ID;
  const secret = process.env.AGENT_EVAL_SECRET;
  if (!keyId || !/^[\w-]{1,128}$/.test(keyId) || !secret) throw new Error(usage);
  // 评测只接收服务地址，固定使用现有运行路由，不跟随重定向发送签名正文。
  let url: URL;
  try { url = new URL('/api/ai/agent/run', values.url); } catch { throw new Error('Invalid service URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Service URL must be HTTP(S) without embedded credentials');
  }
  const timeout = Number(values['timeout-ms'] ?? 30_000);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000) throw new Error('Invalid request timeout');

  const suite = parseSuite(JSON.parse(await readFile(values.suite, 'utf8')));
  const report = await runSuite(suite, async request => {
    // 用实际发送的 JSON 字节串计算摘要，并按服务端验签顺序拼接各字段。
    // 每次请求都生成独立 nonce，避免连续轮次被识别为同一请求的重放。
    const body = JSON.stringify(request);
    const nonce = randomUUID();
    const timestamp = String(Date.now());
    const digest = createHash('sha256').update(body).digest('hex');
    const signature = createHmac('sha256', secret)
      .update([keyId, 'POST', url.pathname, timestamp, nonce, digest].join('\n')).digest('hex');
    const response = await fetch(url, {
      method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: {
        'content-type': 'application/json', 'x-agent-key-id': keyId, 'x-agent-nonce': nonce,
        s_t: timestamp, s_sign: signature,
      },
    });
    // 非 JSON 错误仍保留 HTTP 状态，评测可验证网关或服务器是否按预期拦截。
    return { status: response.status, body: await response.json().catch(() => null) };
  });
  const json = JSON.stringify(report, null, 2) + '\n';
  if (values.out) await writeFile(values.out, json, 'utf8');
  else process.stdout.write(json);
  // 报告写入后才设置断言结果。参数、读文件或写报告失败由入口统一返回 2。
  process.exitCode = report.failed ? 1 : 0;
}

if (require.main === module) void main().catch(error => {
  // SyntaxError 可能把输入文件正文带入消息。
  process.stderr.write((error instanceof SyntaxError ? 'Invalid suite JSON' : error.message) + '\n');
  process.exitCode = 2;
});
