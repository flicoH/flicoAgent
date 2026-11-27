/**
 * 评测断言契约与纯函数库 (EvalAssertions)
 *
 * 【架构职责】
 * 规范 Agent 离线评测与自动化回归测试的断言标准。
 * 纯函数实现，零 Nest 依赖，便于 Node.js 独立跑批脚本直接 import / require 执行。
 */

/**
 * 校验执行步骤轨迹是否命中指定名称列表中的任一项
 *
 * @param steps 步骤列表
 * @param names 期望匹配的能力名称（Skill、Tool 等）
 * @returns 任一名命中即返回 true
 */
export function stepsContain(steps: unknown, names: string[]): boolean {
  if (!Array.isArray(names)) {
    return false;
  }
  if (names.length === 0) {
    return true;
  }
  if (!Array.isArray(steps)) {
    return false;
  }

  for (const name of names) {
    if (!name || typeof name !== 'string') {
      continue;
    }

    for (const step of steps) {
      if (!step || typeof step !== 'object') {
        continue;
      }

      const s = step as Record<string, unknown>;

      // 1. 匹配 step.name
      if (typeof s.name === 'string' && (s.name === name || s.name.includes(name))) {
        return true;
      }

      // 2. 匹配 step.tool
      if (typeof s.tool === 'string' && (s.tool === name || s.tool.includes(name))) {
        return true;
      }

      // 3. 匹配 step.skill
      if (typeof s.skill === 'string' && (s.skill === name || s.skill.includes(name))) {
        return true;
      }

      // 4. 匹配 JSON.stringify(step) 子串（确保 retrieve / list_directory / project-query 等 tool·skill 名必能匹配）
      try {
        const rawJson = JSON.stringify(step);
        if (rawJson && rawJson.includes(name)) {
          return true;
        }
      } catch {
        // 忽略无法序列化的特殊对象
      }
    }
  }

  return false;
}

/**
 * 校验输出是否非空
 *
 * @param output 输出内容
 * @returns 是否非空
 */
export function outputNotEmpty(output: unknown): boolean {
  if (output === null || output === undefined) {
    return false;
  }
  if (typeof output === 'string') {
    return output.trim().length > 0;
  }
  if (typeof output === 'number' || typeof output === 'boolean') {
    return true;
  }
  if (typeof output === 'object') {
    if (Array.isArray(output)) {
      return output.length > 0;
    }
    return Object.keys(output).length > 0;
  }
  return String(output).trim().length > 0;
}

/**
 * 校验步骤轨迹中是否包含安全护栏拦截记录 (type=guardrail)
 *
 * @param steps 步骤列表
 * @returns 是否包含 guardrail 拦截
 */
export function guardrailBlocked(steps: unknown): boolean {
  if (!Array.isArray(steps)) {
    return false;
  }

  return steps.some((step) => {
    if (!step || typeof step !== 'object') {
      return false;
    }
    return (step as Record<string, unknown>).type === 'guardrail';
  });
}

/**
 * 校验输出是否包含候选字符串数组中的任意一项
 *
 * @param output 待检查的输出文本或对象
 * @param needles 候选匹配子串列表
 * @returns 是否命中任一子串
 */
export function outputContainsAny(output: unknown, needles: string[]): boolean {
  if (!Array.isArray(needles) || needles.length === 0) {
    return false;
  }

  let text = '';
  if (typeof output === 'string') {
    text = output;
  } else if (output === null || output === undefined) {
    return false;
  } else if (typeof output === 'object') {
    try {
      text = JSON.stringify(output);
    } catch {
      text = String(output);
    }
  } else {
    text = String(output);
  }

  return needles.some((needle) => {
    if (typeof needle !== 'string' || needle.length === 0) {
      return false;
    }
    return text.includes(needle);
  });
}

/**
 * 断言规约契约
 */
export interface AssertSpec {
  outputNotEmpty?: boolean;
  guardrailBlocked?: boolean;
  blocked?: boolean;
  stepsContain?: string[] | string;
  outputContainsAny?: string[];
  outputContains?: string[] | string;
  custom?: (result: unknown) => boolean | { pass: boolean; reason?: string };
}

/**
 * 综合执行断言集合并返回测试通过状态与原因
 *
 * @param result Agent 运行返回的结果实体 ({ runId, output, steps, threadId })
 * @param assertSpec 断言规约或断言函数
 * @returns { pass: boolean, reason?: string }
 */
export function runAssertions(
  result: unknown,
  assertSpec: AssertSpec | AssertSpec[] | ((res: unknown) => boolean | { pass: boolean; reason?: string }),
): { pass: boolean; reason?: string } {
  if (!assertSpec) {
    return { pass: true };
  }

  if (typeof assertSpec === 'function') {
    const fnResult = assertSpec(result);
    if (typeof fnResult === 'boolean') {
      return fnResult ? { pass: true } : { pass: false, reason: 'Custom assertion returned false' };
    }
    return fnResult;
  }

  if (Array.isArray(assertSpec)) {
    for (const spec of assertSpec) {
      const res = runAssertions(result, spec);
      if (!res.pass) {
        return res;
      }
    }
    return { pass: true };
  }

  const actualResult = (result && typeof result === 'object' && 'data' in result && (result as any).data && typeof (result as any).data === 'object')
    ? (result as any).data
    : result;
  const steps = (actualResult as any)?.steps;
  const output = (actualResult as any)?.output;

  // 1. outputNotEmpty 断言
  if (assertSpec.outputNotEmpty === true) {
    if (!outputNotEmpty(output)) {
      return { pass: false, reason: 'Assertion failed: expected output to not be empty' };
    }
  }

  // 2. guardrailBlocked 断言
  const checkBlocked = assertSpec.guardrailBlocked ?? assertSpec.blocked;
  if (checkBlocked !== undefined) {
    const isBlocked = guardrailBlocked(steps);
    if (checkBlocked && !isBlocked) {
      return { pass: false, reason: 'Assertion failed: expected guardrail to block execution' };
    }
    if (!checkBlocked && isBlocked) {
      return { pass: false, reason: 'Assertion failed: expected guardrail not to block execution' };
    }
  }

  // 3. stepsContain 断言
  if (assertSpec.stepsContain !== undefined) {
    const names = Array.isArray(assertSpec.stepsContain)
      ? assertSpec.stepsContain
      : [assertSpec.stepsContain];
    if (!stepsContain(steps, names)) {
      return {
        pass: false,
        reason: `Assertion failed: expected steps to contain any of [${names.join(', ')}]`,
      };
    }
  }

  // 4. outputContainsAny 断言
  if (assertSpec.outputContainsAny !== undefined) {
    const needles = Array.isArray(assertSpec.outputContainsAny)
      ? assertSpec.outputContainsAny
      : [assertSpec.outputContainsAny];
    if (!outputContainsAny(output, needles)) {
      return {
        pass: false,
        reason: `Assertion failed: expected output to contain any of [${needles.join(', ')}]`,
      };
    }
  }

  // 5. outputContains 断言 (兼容单项或别名)
  if (assertSpec.outputContains !== undefined) {
    const needles = Array.isArray(assertSpec.outputContains)
      ? assertSpec.outputContains
      : [assertSpec.outputContains];
    if (!outputContainsAny(output, needles)) {
      return {
        pass: false,
        reason: `Assertion failed: expected output to contain [${needles.join(', ')}]`,
      };
    }
  }

  // 6. custom 自定义断言
  if (typeof assertSpec.custom === 'function') {
    const customResult = assertSpec.custom(actualResult);
    if (typeof customResult === 'boolean') {
      if (!customResult) {
        return { pass: false, reason: 'Assertion failed: custom assertion returned false' };
      }
    } else if (customResult && !customResult.pass) {
      return customResult;
    }
  }

  return { pass: true };
}
