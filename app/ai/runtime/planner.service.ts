import { Injectable } from '@nestjs/common';
import { LlmGateway } from '../llm/llm.gateway';
import {
  LlmAssistantMessage,
  LlmChatResult,
  LlmMessage,
} from '../llm/llm.interface';
import { PlanResult } from './runtime.types';

/**
 * 校验给定值是否为异步迭代器（流式响应）
 *
 * @param value 待检测对象
 * @returns 是否为 AsyncIterable
 */
function isAsyncIterable(value: unknown): value is AsyncIterable<string> {
  return value !== null
    && typeof value === 'object'
    && Symbol.asyncIterator in value;
}

/**
 * Prompt-JSON 兜底响应的结构定义
 * 针对不支持原生 Function Calling 的模型或旧版模型的 JSON 协议定义
 */
interface JsonPlan {
  action?: string;
  name?: string;
  input?: unknown;
  response?: string;
}

/**
 * 兜底系统提示词：指导模型在不支持原生 Tool Calls 时通过标准 JSON 格式进行决策
 */
const JSON_FALLBACK_PROMPT = [
  '优先使用提供的工具。若模型不能返回原生 tool_calls，只能返回 JSON。',
  '调用能力：{"action":"call","name":"工具名","input":{}}。',
  '完成回答：{"action":"final","response":"最终回答"}。',
].join('\n');

/**
 * 从文本中安全提取并解析 JSON 对象
 * 支持纯 JSON、markdown 代码块 (```json ... ```) 以及包裹在描述性文本中的 JSON
 */
function extractJson<T = unknown>(text: string): T | null {
  if (!text || typeof text !== 'string') {
    return null;
  }
  const trimmed = text.trim();

  // 1. 尝试直接整串解析
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // 继续尝试正则提取
  }

  // 2. 匹配 ```json ... ``` 或 ``` ... ``` 代码块中的内容
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch?.[1]) {
    try {
      return JSON.parse(codeBlockMatch[1].trim()) as T;
    } catch {
      // 继续尝试提取花括号
    }
  }

  // 3. 匹配最外层的 {...} 对象结构
  const startIdx = trimmed.indexOf('{');
  const endIdx = trimmed.lastIndexOf('}');
  if (startIdx !== -1 && endIdx > startIdx) {
    try {
      return JSON.parse(trimmed.slice(startIdx, endIdx + 1)) as T;
    } catch {
      // 解析失败
    }
  }

  return null;
}

/**
 * 规划器服务 (PlannerService)
 *
 * 【ReAct 推理大脑】
 * 负责接收当前多轮消息历史与可用工具描述，驱动大模型进行下一步推理与决策：
 * 1. 采用双模解析策略：
 *    - 优先采用上游模型的原生 Function Calling (`tool_calls` 或 `function_call`)；
 *    - 没有原生调用时，尝试从 assistant 文本中解析 JSON；
 *    - 原生调用的 arguments 无法解析时，仍执行该调用，参数回退为空对象；
 *    - 若既无 tool_calls 又非约定 JSON，则视为模型直接产出的最终文本答复。
 * 2. 保证非流式同步调用，确保单步决策原子性。
 */
@Injectable()
export class PlannerService {
  /**
   * 构造函数注入 LlmGateway 网关
   * @param llm 大模型统一网关
   */
  constructor(private readonly llm: LlmGateway) {}

  /**
   * 执行单轮规划
   *
   * @param messages 当前完整的多轮对话历史
   * @param tools 当前 Agent 允许使用的工具/能力列表（JSON Schema 声明）
   * @param model 可选的模型名称覆盖
   * @returns 规划结果 PlanResult（决策动作 + 原始 assistant 消息 + toolCallId）
   */
  async plan(
    messages: LlmMessage[],
    tools: unknown[],
    model?: string,
  ): Promise<PlanResult> {
    // 在消息列表头部追加兜底提示词，保证各类模型都能在无法触发 native tools 时产出符合约定的 JSON
    const result = this.llm.chat([
      { role: 'system', content: JSON_FALLBACK_PROMPT },
      ...messages,
    ], { model, tools, stream: false });

    // 规划器依赖完整决策结果，若 Provider 错误返回流则抛错
    if (isAsyncIterable(result)) {
      throw new Error('Planner requires a non-streaming LLM response');
    }

    const completed: LlmChatResult = await result;
    // 兼容可能仅返回 output 的第三方 Provider，同时优先保留原装 assistant 消息
    const response: LlmAssistantMessage = completed.message ?? {
      role: 'assistant',
      content: completed.output,
    };

    // 1. 优先尝试解析原生 Function Calling (tool_calls 或 legacy function_call)
    const rawToolCalls = response.tool_calls;
    const rawFunctionCall = (response as unknown as { function_call?: { name: string; arguments: string } }).function_call;

    // 每轮只处理第一个原生 tool_call；旧版 function_call 没有 ID，因此生成一个。
    const toolCall = rawToolCalls?.[0] ?? (rawFunctionCall
      ? { id: `call-${Date.now()}`, type: 'function' as const, function: rawFunctionCall }
      : undefined);

    if (toolCall?.function?.name) {
      let input: unknown = {};
      const rawArgs = toolCall.function.arguments;

      if (typeof rawArgs === 'string' && rawArgs.trim()) {
        try {
          input = JSON.parse(rawArgs);
        } catch {
          input = extractJson(rawArgs) ?? {};
        }
      } else if (typeof rawArgs === 'object' && rawArgs !== null) {
        input = rawArgs;
      }

      return {
        action: {
          type: 'invoke',
          name: toolCall.function.name,
          input,
        },
        response,
        toolCallId: toolCall.id ?? `call-${Date.now()}`,
      };
    }

    // 2. 尝试从模型输出文本中做 JSON 兜底匹配或直接产出最终回答
    return this.parseJsonFallback(response, completed.output);
  }

  /**
   * 解析模型返回的普通文本或 JSON 文本，提取决策动作
   *
   * @param response 助手原始消息
   * @param output 文本输出
   * @returns PlanResult 决策结果
   */
  private parseJsonFallback(
    response: LlmAssistantMessage,
    output: string,
  ): PlanResult {
    // 优先使用原始 assistant 消息；只有 content 为 null/undefined 时才使用 output。
    const content = (response.content ?? output ?? '').trim();

    const parsed = extractJson<JsonPlan>(content);
    if (parsed && typeof parsed === 'object') {
      const isCallAction = parsed.action === 'call'
        || parsed.action === 'skill'
        || parsed.action === 'tool'
        || parsed.action === 'invoke';

      // 命中工具调用约定：{"action":"call"|"skill"|"tool", "name":..., "input":...}
      if (isCallAction && typeof parsed.name === 'string' && parsed.name) {
        // 文本协议没有上游调用 ID，生成关联 ID 供后续观察步骤使用。
        const toolCallId = `fallback-${Date.now()}`;
        return {
          action: { type: 'invoke', name: parsed.name, input: parsed.input ?? {} },
          response,
          toolCallId,
        };
      }

      // 命中结束回答约定：{"action":"final", "response":"..."}
      if (parsed.action === 'final' && typeof parsed.response === 'string') {
        return {
          action: { type: 'final', output: parsed.response },
          response,
        };
      }
    }

    return {
      action: { type: 'final', output: content },
      response,
    };
  }
}
