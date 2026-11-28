import type { BuiltinToolFactory } from '../tool.interface';

const MAX_EXPRESSION_LENGTH = 1024;
const MAX_PARSE_DEPTH = 64;

const CONSTANTS = new Map<string, number>([
  ['PI', Math.PI],
  ['E', Math.E],
]);

const FUNCTIONS = new Map<string, (...args: number[]) => number>([
  ['abs', x => Math.abs(x)],
  ['ceil', x => Math.ceil(x)],
  ['floor', x => Math.floor(x)],
  ['round', (x, digits) => {
    if (digits === undefined) return Math.round(x);
    if (!Number.isInteger(digits) || digits < 0 || digits > 12) {
      throw new Error('round digits must be an integer between 0 and 12');
    }
    const factor = 10 ** digits;
    return Math.round(x * factor) / factor;
  }],
  ['sqrt', x => Math.sqrt(x)],
  ['pow', (base, exp) => Math.pow(base, exp)],
  ['min', (...args) => {
    if (args.length === 0) throw new Error('min requires at least 1 argument');
    return Math.min(...args);
  }],
  ['max', (...args) => {
    if (args.length === 0) throw new Error('max requires at least 1 argument');
    return Math.max(...args);
  }],
  ['log', x => Math.log(x)],
  ['log10', x => Math.log10(x)],
  ['exp', x => Math.exp(x)],
  ['sin', x => Math.sin(x)],
  ['cos', x => Math.cos(x)],
  ['tan', x => Math.tan(x)],
  ['clamp', (value, minVal, maxVal) => {
    if (minVal === undefined || maxVal === undefined) {
      throw new Error('clamp requires 3 arguments: clamp(value, min, max)');
    }
    if (minVal > maxVal) {
      throw new Error('clamp min must be less than or equal to max');
    }
    return Math.min(Math.max(value, minVal), maxVal);
  }],
]);

type Token =
  | { type: 'number'; value: number }
  | { type: 'ident'; value: string }
  | { type: 'op'; value: '+' | '-' | '*' | '/' | '%' | '^' }
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'comma' };

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < expression.length) {
    const ch = expression[index];

    if (/\s/.test(ch)) {
      index++;
      continue;
    }

    if ((ch >= '0' && ch <= '9') || (ch === '.' && index + 1 < expression.length && /[0-9]/.test(expression[index + 1]))) {
      const match = expression.slice(index).match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
      if (!match) {
        throw new Error(`Invalid number near position ${index}`);
      }
      const num = Number(match[0]);
      if (!Number.isFinite(num)) {
        throw new Error(`Number out of finite range: "${match[0]}"`);
      }
      tokens.push({ type: 'number', value: num });
      index += match[0].length;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let end = index + 1;
      while (end < expression.length && /[A-Za-z0-9_]/.test(expression[end])) {
        end++;
      }
      tokens.push({ type: 'ident', value: expression.slice(index, end) });
      index = end;
      continue;
    }

    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%' || ch === '^') {
      tokens.push({ type: 'op', value: ch });
      index++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen' });
      index++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen' });
      index++;
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: 'comma' });
      index++;
      continue;
    }

    throw new Error(`Unexpected character "${ch}" at position ${index}`);
  }

  return tokens;
}

/**
 * 纯递归下降数学表达式求值器（零 eval / new Function / vm）。
 */
export function evaluateMathExpression(
  expression: string,
  variables?: Record<string, number>,
): number {
  if (typeof expression !== 'string' || !expression.trim()) {
    throw new Error('Expression must be a non-empty string');
  }
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    throw new Error(`Expression exceeds maximum length of ${MAX_EXPRESSION_LENGTH} characters`);
  }

  const safeVars = new Map<string, number>();
  if (variables && typeof variables === 'object') {
    for (const [key, value] of Object.entries(variables)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Variable "${key}" must be a finite number`);
      }
      safeVars.set(key, value);
    }
  }

  const tokens = tokenize(expression);
  if (tokens.length === 0) {
    throw new Error('Expression is empty');
  }

  let cursor = 0;

  const peek = (): Token | undefined => tokens[cursor];
  const consume = (): Token => tokens[cursor++];

  const parseExpression = (depth: number): number => {
    if (depth > MAX_PARSE_DEPTH) {
      throw new Error('Expression nesting depth exceeded limit');
    }
    let left = parseTerm(depth + 1);
    while (true) {
      const next = peek();
      if (next?.type === 'op' && (next.value === '+' || next.value === '-')) {
        consume();
        const right = parseTerm(depth + 1);
        left = next.value === '+' ? left + right : left - right;
      } else {
        break;
      }
    }
    return left;
  };

  const parseTerm = (depth: number): number => {
    if (depth > MAX_PARSE_DEPTH) {
      throw new Error('Expression nesting depth exceeded limit');
    }
    let left = parseUnary(depth + 1);
    while (true) {
      const next = peek();
      if (next?.type === 'op' && (next.value === '*' || next.value === '/' || next.value === '%')) {
        consume();
        const right = parseUnary(depth + 1);
        if (next.value === '*') {
          left *= right;
        } else if (next.value === '/') {
          if (right === 0) throw new Error('Division by zero');
          left /= right;
        } else {
          if (right === 0) throw new Error('Modulo by zero');
          left %= right;
        }
      } else {
        break;
      }
    }
    return left;
  };

  const parseUnary = (depth: number): number => {
    if (depth > MAX_PARSE_DEPTH) {
      throw new Error('Expression nesting depth exceeded limit');
    }
    const next = peek();
    if (next?.type === 'op' && (next.value === '+' || next.value === '-')) {
      consume();
      const val = parseUnary(depth + 1);
      return next.value === '-' ? -val : val;
    }
    return parsePower(depth + 1);
  };

  const parsePower = (depth: number): number => {
    if (depth > MAX_PARSE_DEPTH) {
      throw new Error('Expression nesting depth exceeded limit');
    }
    const base = parsePrimary(depth + 1);
    const next = peek();
    if (next?.type === 'op' && next.value === '^') {
      consume();
      const exponent = parseUnary(depth + 1);
      return Math.pow(base, exponent);
    }
    return base;
  };

  const parsePrimary = (depth: number): number => {
    if (depth > MAX_PARSE_DEPTH) {
      throw new Error('Expression nesting depth exceeded limit');
    }
    const tok = peek();
    if (!tok) {
      throw new Error('Unexpected end of expression');
    }
    if (tok.type === 'number') {
      consume();
      return tok.value;
    }
    if (tok.type === 'lparen') {
      consume();
      const value = parseExpression(depth + 1);
      if (peek()?.type !== 'rparen') {
        throw new Error('Missing closing parenthesis ")"');
      }
      consume();
      return value;
    }
    if (tok.type === 'ident') {
      consume();
      if (peek()?.type === 'lparen') {
        const fn = FUNCTIONS.get(tok.value);
        if (!fn) {
          throw new Error(`Unknown function "${tok.value}"`);
        }
        consume(); // '('
        const args: number[] = [];
        if (peek()?.type !== 'rparen') {
          args.push(parseExpression(depth + 1));
          while (peek()?.type === 'comma') {
            consume();
            args.push(parseExpression(depth + 1));
          }
        }
        if (peek()?.type !== 'rparen') {
          throw new Error(`Missing closing parenthesis for function "${tok.value}"`);
        }
        consume(); // ')'
        return fn(...args);
      }
      if (safeVars.has(tok.value)) {
        return safeVars.get(tok.value)!;
      }
      if (CONSTANTS.has(tok.value)) {
        return CONSTANTS.get(tok.value)!;
      }
      throw new Error(`Unknown identifier "${tok.value}"`);
    }
    throw new Error('Unexpected token in expression');
  };

  const result = parseExpression(0);
  if (cursor < tokens.length) {
    throw new Error('Unexpected trailing tokens in expression');
  }
  if (!Number.isFinite(result)) {
    throw new Error('Expression evaluated to a non-finite number');
  }
  return result;
}

/**
 * 框架内置工具：安全数学表达式求值工具 (calculator)
 */
const calculatorTool: BuiltinToolFactory = () => ({
  name: 'calculator',
  description: '精确计算数学与财务公式表达式（支持 + - * / % ^、括号、PI/E、abs/round/sqrt/pow/min/max/clamp 等安全函数与数值变量）。',
  source: 'builtin',
  inputSchema: {
    type: 'object',
    required: ['expression'],
    additionalProperties: false,
    properties: {
      expression: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_EXPRESSION_LENGTH,
        description: '数学表达式，例如 "(price * qty) * (1 - discount)" 或 "round(123.456, 2)"',
      },
      variables: {
        type: 'object',
        additionalProperties: { type: 'number' },
        description: '可选数值变量映射表',
      },
    },
  },
  async execute(rawInput: unknown): Promise<unknown> {
    const input = rawInput as { expression: string; variables?: Record<string, number> };
    const result = evaluateMathExpression(input.expression, input.variables);
    return {
      expression: input.expression,
      result,
    };
  },
});

export default calculatorTool;
