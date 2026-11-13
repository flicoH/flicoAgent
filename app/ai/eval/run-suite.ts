import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import Ajv from 'ajv';
import { runAssertions, type AssertSpec } from './assertions';

/** 一次评测请求。预期状态码可验证 403 等接口权限，断言可检查业务结果。 */
export interface EvalTurn {
  input: unknown;
  expectStatus?: number;
  assert?: AssertSpec;
}

export interface EvalSuite {
  cases: Array<{ id: string; agent: string; turns: EvalTurn[] }>;
}

/** 评测器只依赖统一请求和响应，由 CLI 提供签名与传输，也可注入本地替身。 */
type Invoke = (request: { agent: string; input: unknown; threadId: string }) =>
  Promise<{ status: number; body: unknown }>;

const text = { type: 'string', minLength: 1 };
const texts = { type: 'array', minItems: 1, items: text };
const oneOrMany = { anyOf: [text, texts] };
// 拒绝未知字段，防止断言名称写错后用例在没有执行预期检查的情况下通过。
const validate = new Ajv().compile({
  type: 'object', required: ['cases'], additionalProperties: false,
  properties: {
    cases: {
      type: 'array', minItems: 1, items: {
        type: 'object', required: ['id', 'agent', 'turns'], additionalProperties: false,
        properties: {
          id: text, agent: text,
          turns: {
            type: 'array', minItems: 1, items: {
              type: 'object', required: ['input'], additionalProperties: false,
              properties: {
                input: {},
                expectStatus: { type: 'integer', minimum: 200, maximum: 599 },
                assert: {
                  type: 'object', additionalProperties: false, minProperties: 1,
                  properties: {
                    outputNotEmpty: { type: 'boolean' }, guardrailBlocked: { type: 'boolean' },
                    blocked: { type: 'boolean' }, stepsContain: oneOrMany,
                    outputContains: oneOrMany, outputContainsAny: texts,
                    toolsUsed: texts, citationDocIds: texts,
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});

/** 发送任何请求前验证文件结构，并保证报告中的用例 ID 可唯一定位。 */
export function parseSuite(value: unknown): EvalSuite {
  if (!validate(value)) throw new Error('Invalid evaluation suite: ' + new Ajv().errorsText(validate.errors));
  const suite = value as EvalSuite;
  if (new Set(suite.cases.map(item => item.id)).size !== suite.cases.length) {
    throw new Error('Evaluation case IDs must be unique');
  }
  return suite;
}

/** 顺序执行，单个用例共享线程、用例间隔离。失败的用例不继续发送后续轮次。 */
export async function runSuite(suite: EvalSuite, invoke: Invoke) {
  const cases = [];
  for (const test of suite.cases) {
    const threadId = randomUUID();
    const turns = [];
    for (const [index, turn] of test.turns.entries()) {
      const start = performance.now();
      try {
        const { status, body } = await invoke({ agent: test.agent, input: turn.input, threadId });
        const payload = body as { success?: boolean; data?: { runId?: string; status?: string } } | null;
        const expected = turn.expectStatus;
        const statusMatches = expected === undefined ? status >= 200 && status < 300 : status === expected;
        // 先判定 HTTP 状态。预期为 2xx 时还必须有业务运行结果，部分旧接口错误也返回 HTTP 200。
        // 对失败运行仅放行明确期待护栏拦截的断言，随后仍要确认 Trace 中确实记录了拦截。
        const result = !statusMatches
          ? { pass: false, reason: `Unexpected HTTP status: ${status}` }
          : status < 300 && (payload?.success !== true || !payload.data?.runId)
            ? { pass: false, reason: 'Response does not contain an Agent run' }
            : ['waiting_approval', 'cancelled', 'interrupted'].includes(payload?.data?.status ?? '')
              ? { pass: false, reason: 'Run did not finish; evaluation requires an isolated synchronous Agent' }
              : payload?.data?.status === 'failed' && turn.assert?.guardrailBlocked !== true && turn.assert?.blocked !== true
                ? { pass: false, reason: 'Agent run failed' }
                : runAssertions(body, turn.assert ?? {});
        turns.push({ turn: index + 1, status, runId: payload?.data?.runId, ...result,
          durationMs: Math.round(performance.now() - start) });
        if (!result.pass) break;
      } catch {
        // 请求异常可能携带 URL、正文或认证参数；报告只记通用失败原因。
        turns.push({ turn: index + 1, pass: false, reason: 'Evaluation request failed',
          durationMs: Math.round(performance.now() - start) });
        break;
      }
    }
    // 失败后会提前结束当前用例。通过要求所有声明的轮次都有结果且断言均通过。
    cases.push({ id: test.id, agent: test.agent, pass: turns.length === test.turns.length && turns.every(t => t.pass), turns });
  }
  const passed = cases.filter(item => item.pass).length;
  return { version: 1, total: cases.length, passed, failed: cases.length - passed, cases };
}
