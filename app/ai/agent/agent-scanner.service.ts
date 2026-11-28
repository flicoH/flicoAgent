import { Injectable, OnModuleInit } from '@nestjs/common';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import { isValidOutputSchema } from '../runtime/internal/structured-output';
import { AgentDefinition, isAgentLoopMode } from './agent.interface';

// 用于动态加载业务 demo 编译后的 Agent 及 Prompt CommonJS 模块
const runtimeRequire = createRequire(__filename);
// glob@7 未提供符合当前项目配置的 TS 类型声明，因此在加载处显式约束 sync 函数签名
const globSync = (runtimeRequire('glob') as { sync(pattern: string): string[] }).sync;

/**
 * 动态加载后的 Agent 模块形状
 * 业务 Agent 定义必须通过 default export 暴露
 */
interface AgentModule {
  default?: unknown;
}

/**
 * 校验动态加载的值是否满足 AgentDefinition 的契约要求
 *
 * 【运行时类型防卫】
 * 避免动态加载编译产物时因未通过 TypeScript 编译检查而引入非法结构：
 * - 必须为非 null 的对象
 * - name 必须是非空字符串
 * - skills 和 tools 必须是字符串数组
 * - prompt, promptFile, model 可选，若存在必须为字符串
 *
 * @param value 待校验的任意值
 * @returns 是否符合 AgentDefinition
 */
function isAgentDefinition(value: unknown): value is AgentDefinition {
  // 排除 null、函数与基础类型；具体字段继续在下方检查。
  if (value === null || typeof value !== 'object') {
    return false;
  }
  // 逐字段进行运行时类型与完整性校验
  const agent = value as Partial<AgentDefinition>;
  return typeof agent.name === 'string'
    && Boolean(agent.name)
    && Array.isArray(agent.skills)
    && agent.skills.every(item => typeof item === 'string')
    && Array.isArray(agent.tools)
    && agent.tools.every(item => typeof item === 'string')
    && (agent.delegates === undefined || (Array.isArray(agent.delegates)
      && agent.delegates.every(item => typeof item === 'string' && Boolean(item.trim()))))
    && (agent.delegationOnly === undefined || typeof agent.delegationOnly === 'boolean')
    && (agent.prompt === undefined || typeof agent.prompt === 'string')
    && (agent.promptFile === undefined || typeof agent.promptFile === 'string')
    && (agent.model === undefined || typeof agent.model === 'string')
    && (agent.fallbacks === undefined || (Array.isArray(agent.fallbacks)
      && agent.fallbacks.every(item => typeof item === 'string' && Boolean(item.trim()))))
    && (agent.temperature === undefined
      || (typeof agent.temperature === 'number' && Number.isFinite(agent.temperature) && agent.temperature >= 0))
    && (agent.maxTokens === undefined
      || (typeof agent.maxTokens === 'number' && Number.isSafeInteger(agent.maxTokens) && agent.maxTokens > 0))
    && (agent.topP === undefined
      || (typeof agent.topP === 'number' && Number.isFinite(agent.topP) && agent.topP > 0 && agent.topP <= 1))
    && (agent.timeoutMs === undefined
      || (typeof agent.timeoutMs === 'number' && Number.isSafeInteger(agent.timeoutMs) && agent.timeoutMs > 0))
    && (agent.timeout === undefined
      || (typeof agent.timeout === 'number' && Number.isSafeInteger(agent.timeout) && agent.timeout > 0))
    && (agent.outputSchema === undefined || isValidOutputSchema(agent.outputSchema))
    && (agent.maxOutputRetries === undefined
      || (typeof agent.maxOutputRetries === 'number' && Number.isSafeInteger(agent.maxOutputRetries) && agent.maxOutputRetries >= 0))
    && (agent.mode === undefined || isAgentLoopMode(agent.mode))
    && (agent.maxReflectionRevisions === undefined
      || (Number.isSafeInteger(agent.maxReflectionRevisions) && agent.maxReflectionRevisions >= 0));
}

/**
 * Agent 声明扫描与注册服务 (AgentScannerService)
 *
 * 【核心职责】
 * 在 Nest 模块初始化阶段 (onModuleInit) 自动扫描业务 demo 工程编译产物中的 Agent 声明：
 * 1. 扫描路径：`dist/agents/**\/*.agent.js`；
 * 2. 校验 Agent 规范与唯一性命名，重复或不合法时在启动阶段即时抛错；
 * 3. 解析外部提示词模块 (promptFile)，将加载后的文本归一化写入 prompt 字段；
 * 4. 维护内存注册表，向 Controller 及 Runtime 提供 Agent 查询与列表查询能力。
 */
@Injectable()
export class AgentScannerService implements OnModuleInit {
  /** 以 Agent name 为唯一键保存解析就绪的 Agent 声明映射表 */
  private readonly agents = new Map<string, AgentDefinition>();

  /**
   * 模块生命周期初始化钩子：执行全量 Agent 扫描与注册
   */
  onModuleInit(): void {
    // process.cwd() 指向业务 demo，框架仅扫描其构建目录下的编译产物
    const pattern = resolve(process.cwd(), 'dist/agents/**/*.agent.js');

    for (const filePath of globSync(pattern)) {
      // 每个 *.agent.js 约定只读取 default export
      const loaded = runtimeRequire(filePath) as AgentModule;
      const agent = loaded.default;

      // 声明格式不合法时在启动阶段立即中断并报错，避免延迟到请求时失败
      if (!isAgentDefinition(agent)) {
        throw new Error(`Invalid default AgentDefinition export: ${filePath}`);
      }
      if (this.agents.has(agent.name)) {
        // name 是后续运行时调度 Agent 的唯一注册键，严禁同名覆盖
        throw new Error(`Duplicate agent name "${agent.name}": ${filePath}`);
      }

      // promptFile 存在时覆盖内联 prompt；路径相对当前 Agent 文件解析。
      const resolved = agent.promptFile
        ? { ...agent, prompt: this.loadPrompt(filePath, agent.promptFile) }
        : agent;

      // Prompt 模块解析完成后写入注册表，确保外部读取到的都是可以直接使用的完整定义
      this.agents.set(resolved.name, resolved);
    }

    for (const agent of this.agents.values()) {
      for (const target of new Set(agent.delegates)) {
        if (!this.agents.has(target)) {
          throw new Error(`Invalid sub-agent "${target}" declared by "${agent.name}"`);
        }
      }
    }

    // 控制台输出启动日志，便于开发者核对已被框架识别的 Agent 列表
    console.log('[AgentScanner] registered agents:', this.listNames());
  }

  /**
   * 按名称获取指定的 Agent 声明
   *
   * @param name Agent 注册名
   * @returns 匹配的 AgentDefinition，未找到则返回 undefined
   */
  get(name: string): AgentDefinition | undefined {
    return this.agents.get(name);
  }

  /**
   * 获取所有已注册 Agent 声明的列表快照
   *
   * @returns 所有已注册 AgentDefinition 数组
   */
  list(): AgentDefinition[] {
    return [...this.agents.values()];
  }

  /**
   * 获取所有已注册 Agent 的名称列表
   *
   * @returns Agent 名称字符串数组
   */
  listNames(): string[] {
    return [...this.agents.keys()];
  }

  /**
   * 相对当前 Agent 声明文件解析并加载 Prompt 提示词模块
   *
   * @param agentFile 当前 *.agent.js 声明文件的绝对路径
   * @param promptFile 声明中配置的 promptFile 路径（相对路径或绝对路径）
   * @returns 加载出的提示词文本内容
   */
  private loadPrompt(agentFile: string, promptFile: string): string {
    // 兼容业务在源码中书写 .ts 路径的情况，映射为构建后的 .js 文件
    const normalized = promptFile.endsWith('.ts')
      ? `${promptFile.slice(0, -3)}.js`
      : promptFile;

    // 若为相对路径，则以当前 *.agent.js 所在目录为基准进行绝对路径解析
    const promptPath = isAbsolute(normalized)
      ? normalized
      : resolve(dirname(agentFile), normalized);

    // 约定 Prompt 模块必须通过 default export 导出一个字符串
    const loaded = runtimeRequire(promptPath) as AgentModule;
    if (typeof loaded.default !== 'string') {
      throw new Error(`Agent promptFile must default export a string: ${promptPath}`);
    }
    return loaded.default;
  }
}
