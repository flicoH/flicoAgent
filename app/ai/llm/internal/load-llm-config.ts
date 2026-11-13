import { ConfigService } from '../../../config/config.service';
import { LlmChatOptions, LlmProvider } from '../llm.interface';
import { OpenAiCompatibleProvider } from '../providers/openai-compatible';

/**
 * 单个 LLM 模型的配置项结构
 */
interface LlmModelConfig {
  /** Provider 类型标识，内置通用实现为 'openai-compatible' */
  provider?: string;
  /** API 根路径（例如 'https://dashscope.aliyuncs.com/compatible-mode/v1'），不包含 '/chat/completions' */
  baseURL?: string;
  /** 上游模型名称（例如 'qwen-plus', 'gpt-4o' 等） */
  model?: string;
  /** 模型授权 API Key，由各环境配置（config.local.js, config.prod.js）覆盖 */
  apiKey?: string;
  /** 业务自定义 Provider 扩展位：可直接传入 Provider 实例，或接收配置的构造函数 */
  use?: LlmProvider | (new (config: LlmModelConfig) => LlmProvider);
}

/**
 * ai.llm 节点配置契约
 */
interface LlmConfig {
  /** 默认调用的模型 key，如 'qwen' */
  default?: string;
  /** 已声明的模型字典表 */
  models?: Record<string, LlmModelConfig>;
}

/**
 * 根配置中与 ai 相关的配置节点
 */
interface AiConfig {
  llm?: LlmConfig;
}

/**
 * 解析并获取当前调用所需的大模型提供者 (LlmProvider)
 *
 * 【解析流程与设计规范】
 * 1. 确定本次请求目标模型：优先采用入参 options.model，未指定时采用全局配置 `ai.llm.default`；
 * 2. 检索对应模型配置项 `ai.llm.models[modelName]`，未配置则抛错；
 * 3. 检查是否自定义注入了 `use` Provider：
 *    - 若为构造函数，通过 `new modelConfig.use(modelConfig)` 创建；
 *    - 若为实例，直接复用该对象；
 * 4. 若为框架内置通用提供商 (`provider === 'openai-compatible'`)：
 *    - 校验 apiKey 存在性且严禁占位符（如 'xxxx'）；
 *    - 校验 baseURL 与 model 配置完整性；
 *    - 返回实例化的 `OpenAiCompatibleProvider`；
 * 5. 暂不支持的 provider 类型则抛出明确错误。
 *
 * @param configService 全局配置服务
 * @param options 调用选项
 * @returns 解析得到的 LlmProvider 实例
 * @throws 配置缺失或非法时抛出详细 Error
 */
export function resolveLlmProvider(
  configService: ConfigService,
  options: LlmChatOptions = {},
): LlmProvider {
  const llm = configService.get<AiConfig>('ai')?.llm;
  const modelName = options.model ?? llm?.default;

  if (!modelName) {
    throw new Error('ai.llm.default is not configured');
  }

  const modelConfig = llm?.models?.[modelName];
  if (!modelConfig) {
    throw new Error(`LLM model "${modelName}" is not configured in ai.llm.models`);
  }

  // 1. 业务自定义扩展 Provider 优先
  if (modelConfig.use) {
    return typeof modelConfig.use === 'function'
      ? new modelConfig.use(modelConfig)
      : modelConfig.use;
  }

  // 2. 检查内置 Provider 支持情况
  if (modelConfig.provider !== 'openai-compatible') {
    throw new Error(`Unsupported LLM provider "${modelConfig.provider ?? ''}" for model "${modelName}"`);
  }

  // 3. 拦截占位符或未配置 Key，在请求发出前及时预警
  if (!modelConfig.apiKey || modelConfig.apiKey === 'xxxx') {
    throw new Error(`LLM model "${modelName}" requires a non-placeholder apiKey at ai.llm.models.${modelName}.apiKey`);
  }
  if (!modelConfig.baseURL || !modelConfig.model) {
    throw new Error(`LLM model "${modelName}" requires provider, baseURL, and model configuration`);
  }

  // 4. 创建 OpenAI-compatible 通用提供商
  return new OpenAiCompatibleProvider({
    baseURL: modelConfig.baseURL,
    model: modelConfig.model,
    apiKey: modelConfig.apiKey,
  });
}
