import { Module } from '@nestjs/common';
import { EmbeddingGateway } from './embedding.gateway';

/**
 * 文本向量化模块 (EmbeddingModule)
 *
 * 【职责】
 * 注册并导出向量化统一网关 `EmbeddingGateway`。
 */
@Module({
  providers: [EmbeddingGateway],
  exports: [EmbeddingGateway],
})
export class EmbeddingModule {}
