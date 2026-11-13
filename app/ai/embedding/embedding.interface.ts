/**
 * 文本向量化提供者契约 (EmbeddingProvider)
 *
 * 【统一向量化协议】
 * 支持批量输入文本，返回相同数量和顺序的高维向量。
 */
export interface EmbeddingProvider {
  /**
   * 将一组文本批量计算为向量
   *
   * @param texts 待向量化的文本数组
   * @returns 对应文本的高维向量浮点数数组列表 (number[][])
   */
  embed(texts: string[]): Promise<number[][]>;
}
