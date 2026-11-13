import { ConfigService } from '../../../config/config.service';

/**
 * 缺省最大迭代轮次
 */
export const DEFAULT_MAX_ITERATIONS = 5;

/**
 * 安全解析正整数辅助函数
 * 若值非有效正整数或 <= 0 则返回 null
 *
 * @param value 原始配置项值
 * @returns 解析出的正整数，若无效则返回 null
 */
function parsePositiveInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return null;
}

/**
 * 解析 Agent 运行时的最大循环迭代上限
 *
 * 【解析规范】
 * - 优先读取 `ai.runtime.maxIterations`；
 * - 缺省 / 非数字 / <=0 严格回退为默认值 5（禁止「未配置就不设上限」）；
 * - 本文件专门且仅负责解析循环上限数值，严禁添加任何 engine 开关。
 *
 * @param config 全局配置服务（可选）
 * @returns 经过校验的正整数最大迭代次数
 */
export function resolveMaxIterations(config?: ConfigService): number {
  if (!config) {
    return DEFAULT_MAX_ITERATIONS;
  }
  const rawValue = config.get<unknown>('ai.runtime.maxIterations');
  return parsePositiveInteger(rawValue) ?? DEFAULT_MAX_ITERATIONS;
}
