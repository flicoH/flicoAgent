#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { agentRequestSignature } from '../access/request-signature';
import { parseSuite, runSuite, type EvalTransport } from './run-suite';

const EXIT_CODE = {
  success: 0,
  evaluationFailed: 10,
  invalidSetup: 20,
  reportWriteFailed: 30,
} as const;

const usage = `Usage: flico-agent-eval --suite <file> --url <base-url> [--out <file>] [--timeout-ms <ms>]

  --suite         JSON suite file
  --url           Agent service base URL
  --out           JSON report file (default: stdout)
  --timeout-ms    Per-request timeout (default: 60000)
  --help, -h      Show this help

Set AGENT_EVAL_KEY_ID and AGENT_EVAL_SECRET for request signing.
Exit codes:
  ${EXIT_CODE.success}   All cases passed or help displayed
  ${EXIT_CODE.evaluationFailed}  One or more cases failed
  ${EXIT_CODE.invalidSetup}  Invalid arguments, credentials configuration or suite file
  ${EXIT_CODE.reportWriteFailed}  Could not write the JSON report
`;

function agentEndpoint(baseUrl: string): URL {
  const url = URL.parse(baseUrl);
  if (!url || !['http:', 'https:'].includes(url.protocol)
    || url.username || url.password || url.search || url.hash) {
    throw new Error('--url must be an HTTP(S) base URL without credentials, a query or a fragment');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/ai/agent/run`;
  return url;
}

function signedTransport(url: URL, keyId: string, secret: string, timeout: number): EvalTransport {
  return async request => {
    const body = JSON.stringify(request);
    const timestamp = String(Date.now());
    const nonce = randomUUID();
    const signature = agentRequestSignature(secret, keyId, 'POST', url.pathname, timestamp, nonce, body);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-key-id': keyId,
        'x-agent-nonce': nonce,
        s_t: timestamp,
        s_sign: signature.toString('hex'),
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { status: response.status, body: undefined };
    }
    const raw = await response.text();
    try {
      return { status: response.status, body: JSON.parse(raw) };
    } catch {
      return { status: response.status, body: undefined };
    }
  };
}

async function writeReport(json: string, path?: string): Promise<void> {
  if (path) {
    await writeFile(path, json, 'utf8');
    return;
  }

  const stdout = process.stdout;
  await new Promise<void>((resolve, reject) => {
    stdout.once('error', reject);
    stdout.write(json, error => {
      if (error) {
        reject(error);
        return;
      }
      stdout.off('error', reject);
      resolve();
    });
  });
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: {
    suite: { type: 'string' },
    url: { type: 'string' },
    out: { type: 'string' },
    'timeout-ms': { type: 'string', default: '60000' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    process.stdout.write(usage);
    return EXIT_CODE.success;
  }
  if (!values.suite || !values.url || values.out === '') {
    throw new Error('--suite and --url are required, and --out requires a file path');
  }
  const url = agentEndpoint(values.url);
  const timeout = Number(values['timeout-ms']);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) {
    throw new Error('--timeout-ms must be an integer between 1 and 2147483647');
  }
  const keyId = process.env.AGENT_EVAL_KEY_ID;
  const secret = process.env.AGENT_EVAL_SECRET;
  if (!keyId || !/^[\x21-\x7e]+$/.test(keyId) || !secret?.trim()) {
    throw new Error('Set AGENT_EVAL_KEY_ID and AGENT_EVAL_SECRET to valid signing credentials');
  }

  const rawSuite = await readFile(values.suite, 'utf8');
  let suite: unknown;
  try {
    suite = JSON.parse(rawSuite);
  } catch {
    throw new Error('The suite file contains invalid JSON');
  }
  const report = await runSuite(parseSuite(suite), signedTransport(url, keyId, secret, timeout));
  const json = `${JSON.stringify(report, null, 2)}\n`;
  try {
    await writeReport(json, values.out);
  } catch (error) {
    console.error(`flico-agent-eval: Could not write the JSON report: ${error instanceof Error ? error.message : error}`);
    return EXIT_CODE.reportWriteFailed;
  }
  return report.failed ? EXIT_CODE.evaluationFailed : EXIT_CODE.success;
}

main().then(code => { process.exitCode = code; }).catch(error => {
  console.error(`flico-agent-eval: ${error.message}`);
  process.exitCode = EXIT_CODE.invalidSetup;
});
