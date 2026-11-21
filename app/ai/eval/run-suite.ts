import { randomUUID } from 'node:crypto';
import { runAssertions, type AssertSpec } from './assertions';

type JsonAssertions = Omit<AssertSpec, 'custom'> & { toolsUsed?: string[]; citationDocIds?: string[] };

export interface EvalTurn {
  input: unknown;
  expectStatus?: number;
  assert?: JsonAssertions;
}

export interface EvalSuite {
  cases: { id: string; agent: string; turns: EvalTurn[] }[];
}

export interface EvalRequest {
  agent: string;
  input: unknown;
  threadId: string;
}

export type EvalTransport = (request: EvalRequest) => Promise<{ status: number; body: unknown }>;

interface TurnResult {
  turn: number;
  pass: boolean;
  durationMs: number;
  httpStatus?: number;
  runId?: string;
  failures: string[];
}

export interface EvalReport {
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
  cases: { id: string; pass: boolean; turns: TurnResult[] }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString);
}

function validateKeys(value: Record<string, unknown>, keys: string[], path: string): void {
  const unknownKey = Object.keys(value).find(key => !keys.includes(key));
  if (unknownKey !== undefined) {
    throw new Error(`${path}.${unknownKey} is unsupported`);
  }
}

const assertionValidators = new Map<string, (value: unknown) => boolean>([
  ['outputNotEmpty', value => typeof value === 'boolean'],
  ['guardrailBlocked', value => typeof value === 'boolean'],
  ['blocked', value => typeof value === 'boolean'],
  ['stepsContain', value => nonEmptyString(value) || stringList(value)],
  ['outputContains', value => nonEmptyString(value) || stringList(value)],
  ['outputContainsAny', stringList],
  ['toolsUsed', stringList],
  ['citationDocIds', stringList],
]);

function parseTurn(value: unknown, path: string): EvalTurn {
  if (!isRecord(value) || !Object.hasOwn(value, 'input') || value.input === undefined) {
    throw new Error(`${path}.input is required`);
  }
  validateKeys(value, ['input', 'expectStatus', 'assert'], path);
  const { input, expectStatus, assert } = value;
  if (expectStatus !== undefined && (typeof expectStatus !== 'number'
    || !Number.isInteger(expectStatus) || expectStatus < 200 || expectStatus > 599)) {
    throw new Error(`${path}.expectStatus must be an HTTP status between 200 and 599`);
  }
  if (assert !== undefined) {
    if (!isRecord(assert) || !Object.keys(assert).length) {
      throw new Error(`${path}.assert must be a non-empty object`);
    }
    if (typeof expectStatus === 'number' && expectStatus >= 300) {
      throw new Error(`${path}.assert requires a successful HTTP response`);
    }
    for (const [key, item] of Object.entries(assert)) {
      if (!assertionValidators.get(key)?.(item)) {
        throw new Error(`${path}.assert.${key} is invalid or unsupported`);
      }
    }
  }
  return { input, expectStatus, assert: assert as JsonAssertions | undefined };
}

export function parseSuite(value: unknown): EvalSuite {
  if (!isRecord(value) || !Array.isArray(value.cases) || value.cases.length === 0) {
    throw new Error('suite.cases must be a non-empty array');
  }
  validateKeys(value, ['cases'], 'suite');
  const ids = new Set<string>();
  const cases = value.cases.map((item: unknown, index: number) => {
    const path = `cases[${index}]`;
    if (!isRecord(item) || !nonEmptyString(item.id) || !nonEmptyString(item.agent)
      || !Array.isArray(item.turns) || item.turns.length === 0) {
      throw new Error(`${path} requires an id, an agent and a non-empty turns array`);
    }
    validateKeys(item, ['id', 'agent', 'turns'], path);
    const id = item.id.trim();
    if (ids.has(id)) {
      throw new Error(`${path}.id must be unique`);
    }
    ids.add(id);
    const turns = item.turns.map(
      (turn: unknown, turnIndex: number) => parseTurn(turn, `${path}.turns[${turnIndex}]`),
    );
    return { id, agent: item.agent.trim(), turns };
  });
  return { cases };
}

function evaluateAssertions(
  output: string, steps: Record<string, unknown>[], citations: unknown, assertions: JsonAssertions = {},
): string[] {
  const { toolsUsed, citationDocIds, guardrailBlocked, blocked, ...shared } = assertions;
  const failures = Object.entries(shared).filter(([name, value]) =>
    !runAssertions({ output, steps }, { [name]: value }).pass,
  ).map(([name]) => `Assertion failed: ${name}`);

  const expectedBlock = guardrailBlocked ?? blocked;
  if (expectedBlock !== undefined && steps.some(step => step.type === 'guardrail') !== expectedBlock) {
    failures.push('Assertion failed: guardrailBlocked');
  }
  if (toolsUsed && !toolsUsed.every(name => steps.some(step =>
    (step.type === 'tool' || step.type === 'skill') && step.name === name && !step.error,
  ))) {
    failures.push('Assertion failed: toolsUsed');
  }
  if (citationDocIds && (!Array.isArray(citations) || !citationDocIds.every(docId => citations.some(
    item => isRecord(item) && item.docId === docId && nonEmptyString(item.chunkId),
  )))) {
    failures.push('Assertion failed: citationDocIds');
  }
  return failures;
}

async function evaluateTurn(
  turn: EvalTurn, request: EvalRequest, transport: EvalTransport,
): Promise<Omit<TurnResult, 'turn' | 'durationMs' | 'pass'>> {
  let response: Awaited<ReturnType<EvalTransport>>;
  try {
    response = await transport(request);
  } catch (error) {
    return { failures: [error instanceof Error && error.name === 'TimeoutError'
      ? 'Agent request timed out' : 'Agent request failed'] };
  }

  const { status: httpStatus, body } = response;
  const isSuccess = httpStatus >= 200 && httpStatus < 300;
  if (turn.expectStatus === undefined ? !isSuccess : httpStatus !== turn.expectStatus) {
    return { httpStatus, failures: [`Expected HTTP ${turn.expectStatus ?? '2xx'}, received ${httpStatus}`] };
  }
  if (!isSuccess) {
    return { httpStatus, failures: [] };
  }

  const data = isRecord(body) && body.success === true ? body.data : undefined;
  if (!isRecord(data) || !nonEmptyString(data.runId) || typeof data.output !== 'string'
    || !Array.isArray(data.steps) || !data.steps.every(isRecord)) {
    return { httpStatus, failures: ['Invalid Agent response'] };
  }
  const { runId, output, steps, status, citations } = data;
  const lastStep = steps.at(-1);
  if ((status !== undefined && status !== 'succeeded') || (lastStep?.type === 'final' && lastStep.error)) {
    return { httpStatus, runId, failures: [status === 'waiting_approval'
      ? 'Agent run is waiting for approval' : 'Agent run did not succeed'] };
  }
  return { httpStatus, runId, failures: evaluateAssertions(output, steps, citations, turn.assert) };
}

export async function runSuite(suite: EvalSuite, transport: EvalTransport): Promise<EvalReport> {
  const startedAt = performance.now();
  const cases: EvalReport['cases'] = [];
  for (const testCase of suite.cases) {
    const threadId = randomUUID();
    const turns: TurnResult[] = [];
    for (const [index, turn] of testCase.turns.entries()) {
      const turnStartedAt = performance.now();
      const result = await evaluateTurn(turn, { agent: testCase.agent, input: turn.input, threadId }, transport);
      turns.push({
        ...result,
        turn: index + 1,
        pass: result.failures.length === 0,
        durationMs: Math.round(performance.now() - turnStartedAt),
      });
    }
    cases.push({ id: testCase.id, pass: turns.every(turn => turn.pass), turns });
  }
  const passed = cases.filter(testCase => testCase.pass).length;
  return {
    total: cases.length,
    passed,
    failed: cases.length - passed,
    durationMs: Math.round(performance.now() - startedAt),
    cases,
  };
}
