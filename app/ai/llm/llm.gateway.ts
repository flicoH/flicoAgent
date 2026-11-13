import { Injectable } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import { resolveLlmProvider } from './internal/load-llm-config';
import { LlmChatOptions, LlmChatResult, LlmMessage } from './llm.interface';

/**
 * 大模型网关服务 (LlmGateway)
 *
 * 【统一门面架构】
 * 作为运行时系统 (Runtime) 与控制器 (AiController) 调用大模型的唯一统一入口：
 * 1. 屏蔽不同 LLM 厂商的接入细节与 Provider 切换逻辑；
 * 2. 结合 `ConfigService` 动态解析当前生效的模型配置并装配对应的 `LlmProvider`；
 * 3. 统一规范流式与非流式调用的返回合同。
 */
@Injectable()
export class LlmGateway {
  /**
   * 构造函数注入全局配置服务
   * @param config 全局配置服务
   */
  constructor(private readonly config: ConfigService) {}

  /**
   * 发起大模型对话请求
   *
   * @param messages 消息历史列表
   * @param options 调用选项（如模型名、function calling 工具列表、是否流式等）
   * @returns 非流式返回 Promise<LlmChatResult>，流式返回 AsyncIterable<string>
   */
  chat(
    messages: LlmMessage[],
    options: LlmChatOptions = {},
  ): Promise<LlmChatResult> | AsyncIterable<string> {
    // 每次调用按最新的合并配置动态解析或获取 Provider，确保热更新与无状态特性
    return resolveLlmProvider(this.config, options).chat(messages, options);
  }
}
