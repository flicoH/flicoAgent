import { Injectable } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import { resolveEmbeddingProvider } from './internal/load-embedding-config';

/**
 * 文本向量化网关服务 (EmbeddingGateway)
 *
 * 【统一门面架构】
 * 作为 RAG 检索器、向量索引构建等模块调用 Embedding 的唯一统一入口：
 * 1. 屏蔽不同 Embedding 厂商的接入细节与 Provider 切换逻辑；
 * 2. 结合 `ConfigService` 动态解析当前生效的模型配置并装配对应的 `EmbeddingProvider`；
 * 3. 统一提供纯函数式批量向量转换能力。
 */
@Injectable()
export class EmbeddingGateway {
  constructor(private readonly config: ConfigService) {}

  /**
   * 将文本列表批量计算为向量
   *
   * @param texts 待向量化文本列表
   * @param options 可选参数（例如指定特定向量模型名称）
   * @returns 对应的高维向量列表
   */
  async embed(
    texts: string[],
    options: { model?: string } = {},
  ): Promise<number[][]> {
    if (!texts || texts.length === 0) {
      return [];
    }

    const provider = resolveEmbeddingProvider(this.config, options);
    return provider.embed(texts);
  }
}
