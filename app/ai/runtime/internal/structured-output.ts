import Ajv from 'ajv';

const ajv = new Ajv({ allErrors: true, coerceTypes: false });
const validatorCache = new WeakMap<object, Ajv.ValidateFunction>();

export type StructuredOutputValidationResult =
  | { valid: true; value: unknown; serialized: string }
  | { valid: false; reason: string };

export const DEFAULT_MAX_OUTPUT_RETRIES = 2;

export function isPlainSchemaObject(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).length > 0;
}

/**
 * 编译并缓存 JSON Schema 校验函数；非法 Schema 直接抛错。
 */
export function compileOutputSchema(schema: unknown): Ajv.ValidateFunction {
  if (!isPlainSchemaObject(schema)) {
    throw new Error('outputSchema must be a non-empty JSON Schema object');
  }
  const cached = validatorCache.get(schema);
  if (cached) {
    return cached;
  }
  const validate = ajv.compile(schema);
  validatorCache.set(schema, validate);
  return validate;
}

/**
 * 判断候选对象是否为可被 ajv 正常编译的非空 JSON Schema。
 */
export function isValidOutputSchema(schema: unknown): schema is Record<string, unknown> {
  try {
    compileOutputSchema(schema);
    return true;
  } catch {
    return false;
  }
}

/**
 * 字符串感知的平衡括号扫描：从带有简短前后说明文本的模型输出中提取首个合法 JSON 对象或数组。
 */
function extractBalancedJson(text: string): string | null {
  for (let start = 0; start < text.length; start++) {
    const ch = text[start];
    if (ch !== '{' && ch !== '[') continue;
    const stack: string[] = [ch === '{' ? '}' : ']'];
    let inString = false;
    let escaped = false;

    for (let i = start + 1; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (c === '\\') {
          escaped = true;
        } else if (c === '"') {
          inString = false;
        }
        continue;
      }
      if (c === '"') {
        inString = true;
      } else if (c === '{') {
        stack.push('}');
      } else if (c === '[') {
        stack.push(']');
      } else if (c === '}' || c === ']') {
        if (stack[stack.length - 1] !== c) {
          break;
        }
        stack.pop();
        if (stack.length === 0) {
          const candidate = text.slice(start, i + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

/**
 * 从模型输出文本中提取合法 JSON 值：
 * 1. 直接 JSON.parse；
 * 2. 提取 Markdown 代码块（```json ... ``` 或 ``` ... ```）；
 * 3. 字符串感知的平衡括号提取。
 */
export function extractJsonValue(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, error: 'Output is empty and cannot be parsed as JSON' };
  }
  const trimmed = text.trim();

  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {}

  const fencedMatches = trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi);
  for (const match of fencedMatches) {
    const body = match[1]?.trim();
    if (!body) continue;
    try {
      return { ok: true, value: JSON.parse(body) };
    } catch {}
  }

  const balanced = extractBalancedJson(trimmed);
  if (balanced !== null) {
    try {
      return { ok: true, value: JSON.parse(balanced) };
    } catch {}
  }

  return { ok: false, error: 'Output is not valid JSON' };
}

/**
 * 对模型输出文本执行 JSON 提取与 ajv 严格 Schema 校验。
 */
export function validateStructuredOutput(
  schema: Record<string, unknown>,
  rawText: string,
): StructuredOutputValidationResult {
  const validate = compileOutputSchema(schema);
  const extracted = extractJsonValue(rawText);
  if (!extracted.ok) {
    return { valid: false, reason: extracted.error };
  }
  const valid = validate(extracted.value);
  if (valid) {
    return {
      valid: true,
      value: extracted.value,
      serialized: JSON.stringify(extracted.value),
    };
  }
  const detail = ajv.errorsText(validate.errors) || 'Output did not match outputSchema';
  return { valid: false, reason: detail };
}

/**
 * 注入系统提示词的结构化输出约束指令。
 */
export function buildStructuredOutputInstruction(schema: Record<string, unknown>): string {
  return [
    '最终回答必须严格输出符合以下 JSON Schema 的单个有效 JSON，不要包含 Markdown 代码块标记或额外解释文本：',
    JSON.stringify(schema),
  ].join('\n');
}

/**
 * 校验失败时构造给模型的自动纠错重试提示词。
 */
export function buildStructuredOutputRepairPrompt(
  schema: Record<string, unknown>,
  errorDetail: string,
): string {
  return [
    `上一次输出未通过 JSON Schema 校验：${errorDetail}。`,
    '请仅输出修正后的单个有效 JSON（不要包含 ```json 围栏或任何额外解释文字），必须严格满足以下 JSON Schema：',
    JSON.stringify(schema),
  ].join('\n');
}
