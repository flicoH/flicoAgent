import axios, { AxiosProxyConfig } from 'axios';
import { EmbeddingProvider } from '../embedding.interface';

/**
 * 向量化提供者配置项
 */
export interface DashScopeCompatibleEmbeddingConfig {
  /** API 基础根路径（例如 'https://dashscope.aliyuncs.com/compatible-mode/v1'） */
  baseURL: string;
  /** 向量模型名称（例如 'text-embedding-v3'） */
  model: string;
  /** API Key */
  apiKey: string;
  /** 单次批量请求最大文本条数，默认 16 */
  batchSize?: number;
  /** 最大请求尝试次数（包含首次请求），默认 3 */
  maxRetries?: number;
  /** 网络代理配置，默认 false（避免环境变量中本地 HTTP 代理拦截阿里云国内域名导致 503） */
  proxy?: false | AxiosProxyConfig;
}

/**
 * 上游返回的 Embedding 响应数据结构
 */
interface EmbeddingApiResponse {
  data?: Array<{
    embedding?: number[];
    index?: number;
  }>;
}

/**
 * 延迟辅助函数
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * DashScope / OpenAI 兼容的文本向量化提供者
 *
 * 【核心能力】
 * 1. 批量处理 (Batching)：当输入 texts 规模较大时，按 batchSize 分批向模型服务发起请求；
 * 2. 自动重试 (Retry)：请求或响应校验抛错时，采用指数退避算法重新尝试；
 * 3. 顺序处理：按返回数据项中的 `index` 排序；缺失 index 的项按 0 排序。
 */
export class DashScopeCompatibleEmbeddingProvider implements EmbeddingProvider {
  private readonly batchSize: number;
  private readonly maxRetries: number;

  constructor(private readonly config: DashScopeCompatibleEmbeddingConfig) {
    this.batchSize = config.batchSize ?? 16;
    this.maxRetries = config.maxRetries ?? 3;
  }

  /**
   * 批量将文本数组计算为向量
   *
   * @param texts 待向量化的文本数组
   * @returns 对应文本的高维向量浮点数数组列表
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (!texts || texts.length === 0) {
      return [];
    }

    const allEmbeddings: number[][] = [];

    // 1. 分批处理
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const batchEmbeddings = await this.embedBatchWithRetry(batch);
      allEmbeddings.push(...batchEmbeddings);
    }

    return allEmbeddings;
  }

  /**
   * 单批次请求并带重试逻辑
   */
  private async embedBatchWithRetry(batch: string[]): Promise<number[][]> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.requestBatch(batch);
      } catch (err: any) {
        lastError = err;
        // 如果是最后一次尝试，直接跳出并抛出
        if (attempt === this.maxRetries) {
          break;
        }

        // 服务不可用通常不会在几百毫秒内恢复；优先遵循服务端的 Retry-After。
        const retryAfter = err?.response?.headers?.['retry-after'];
        const seconds = Number(retryAfter);
        const retryAt = typeof retryAfter === 'string' ? Date.parse(retryAfter) : NaN;
        const serverDelay = retryAfter !== undefined && Number.isFinite(seconds) && seconds >= 0
          ? seconds * 1000
          : Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : 0;
        const delayMs = Math.min(Math.max(1000 * Math.pow(2, attempt - 1), serverDelay), 30000);
        await sleep(delayMs);
      }
    }

    let message = lastError instanceof Error ? lastError.message : String(lastError);
    const response = (lastError as { response?: { status: number; data?: unknown; headers?: Record<string, unknown> } })?.response;
    if (response) {
      const data = response.data as { error?: { code?: unknown }; code?: unknown; request_id?: unknown } | undefined;
      const code = data?.error?.code ?? data?.code;
      const requestId = response.headers?.['x-request-id'] ?? data?.request_id;
      // 仅输出状态和诊断标识，不输出请求正文、鉴权信息或上游返回的任意文本。
      message = `HTTP ${response.status}${typeof code === 'string' ? `, code=${code}` : ''}${typeof requestId === 'string' ? `, request_id=${requestId}` : ''}`;
    }
    throw new Error(`Embedding request failed after ${this.maxRetries} attempts: ${message}`);
  }

  /**
   * 发起单次 HTTP 请求
   */
  private async requestBatch(batch: string[]): Promise<number[][]> {
    let base = this.config.baseURL.replace(/\/+$/, '');
    if (base.endsWith('/compatible-mode/v')) {
      base += '1';
    }
    const url = `${base}/embeddings`;
    const response = await axios.post<EmbeddingApiResponse>(
      url,
      {
        model: this.config.model,
        input: batch,
      },
      {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
        proxy: this.config.proxy !== undefined ? this.config.proxy : false,
      },
    );

    const data = response.data?.data;
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error('Embedding response data is empty or invalid');
    }

    // 上游返回顺序可能不同于输入顺序；排序依赖上游提供正确的 index。
    // 此处只校验每项 embedding 为数组，不校验返回数量或 index 的完整性。
    const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return sorted.map((item, idx) => {
      if (!Array.isArray(item.embedding)) {
        throw new Error(`Invalid embedding at index ${idx}`);
      }
      return item.embedding;
    });
  }
}

// 别名导出，确保同时满足 openai-compatible 与 dashscope-compatible 命名规范
export { DashScopeCompatibleEmbeddingProvider as OpenAiCompatibleEmbeddingProvider };
