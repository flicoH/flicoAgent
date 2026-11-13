import { Inject, Injectable } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { BOOTSTRAP_OPTIONS, BootstrapOptions } from './bootstrap-options';

// 用于动态引入配置文件的 require 函数
const runtimeRequire = createRequire(__filename);

/**
 * 判断给定值是否为纯 JavaScript 普通对象 (Plain Object)
 *
 * 【合并规则约束】
 * 仅对普通对象 (Object literal 或 Object.create(null)) 进行深层递归合并；
 * 数组、函数、类实例及基本类型等均视为叶子节点，由后层配置整体直接覆盖。
 *
 * @param value 待检测的值
 * @returns 是否为普通对象
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * 递归深度合并两个配置对象
 *
 * 【优先级机制】
 * source 对象的属性优先级高于 target 对象：
 * - 当相同 key 对应的值两侧皆为普通对象时，继续递归调用 deepMerge 向下合并；
 * - 否则以 source 的值完全覆盖 target 的值；
 * - 保留 target 与 source 中互不冲突的键值。
 *
 * @param target 基础目标对象
 * @param source 覆盖源对象
 * @returns 深度合并后的新对象
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...target };

  for (const [key, sourceValue] of Object.entries(source)) {
    const targetValue = merged[key];
    // 两侧都是普通对象时继续向下合并，否则以后层值覆盖前层值
    merged[key] = isPlainObject(targetValue) && isPlainObject(sourceValue)
      ? deepMerge(targetValue, sourceValue)
      : sourceValue;
  }

  return merged;
}

/**
 * 全局统一配置服务 (ConfigService)
 *
 * 【多层级配置架构】
 * 按照由低到高的优先级进行深合并：
 * 1. 框架默认配置: `config/config.default.js`
 * 2. 业务工程默认配置: `<process.cwd()>/config/config.default.js`
 * 3. 当前运行环境覆盖配置: `<process.cwd()>/config/config.<env>.js` (local, beta, prod)
 * 4. 启动引导选项: `BootstrapOptions` (代码传入的高优先级参数)
 *
 * 【点路径查询】
 * 提供 `get('ai.llm.models.qwen')` 式的安全点路径访问。
 */
@Injectable()
export class ConfigService {
  /** 当前运行环境标识，兼容 _ENV 与 __ENV 环境变量，默认值为 'local' */
  private readonly environment = process.env._ENV ?? process.env.__ENV ?? 'local';

  /** 保存所有配置层深合并后的最终只读配置字典 */
  private readonly config: Record<string, unknown>;

  /**
   * 初始化配置服务，按层次加载并合并所有配置文件
   * @param options 启动引导选项（最高优先级注入）
   */
  constructor(@Inject(BOOTSTRAP_OPTIONS) private readonly options: BootstrapOptions) {
    // 业务工程以运行目录 (cwd) 下的 config 作为配置目录
    const businessConfigPath = resolve(process.cwd(), 'config');
    // 根据环境匹配具体的环境配置文件
    const overlay = this.isLocal()
      ? 'config.local.js'
      : this.isBeta()
        ? 'config.beta.js'
        : this.isProduction()
          ? 'config.prod.js'
          : undefined;

    // 顶层按浅合并（保持已有测试合同: 框架默认 -> 业务默认 -> 环境配置 -> 启动选项）
    // 对于 ai 配置项，允许深层属性覆盖以支持仅改动 ai.llm.default 等场景
    const layers = [
      runtimeRequire(resolve(__dirname, '../../config/config.default.js')),
      this.loadConfig(resolve(businessConfigPath, 'config.default.js')),
      overlay ? this.loadConfig(resolve(businessConfigPath, overlay)) : {},
      options as Record<string, unknown>,
    ].filter(Boolean);

    const mergedTop: Record<string, unknown> = Object.assign({}, ...layers);

    // 如果存在多个 ai 配置，对 ai 进行深度合并
    const aiLayers = layers
      .map(layer => layer.ai)
      .filter(ai => isPlainObject(ai)) as Record<string, unknown>[];

    if (aiLayers.length > 0) {
      mergedTop.ai = aiLayers.reduce(deepMerge, {});
    }

    // 如果存在多个 agentConfig 配置，对 agentConfig 进行深度合并（支持 local/beta/prod 细粒度覆盖）
    const agentConfigLayers = layers
      .map(layer => layer.agentConfig)
      .filter(ac => isPlainObject(ac)) as Record<string, unknown>[];

    if (agentConfigLayers.length > 0) {
      mergedTop.agentConfig = agentConfigLayers.reduce(deepMerge, {});
    }

    this.config = mergedTop;
  }

  /**
   * 按点路径语法读取配置值
   * 例如：`configService.get<string>('ai.llm.default')`
   *
   * @template T 返回值类型
   * @param key 点分隔的配置路径，如 'ai.llm.models'
   * @returns 配置值，若中间节点不存在或类型不匹配则返回 undefined
   */
  get<T = unknown>(key: string): T | undefined {
    let value: unknown = this.config;
    for (const part of key.split('.')) {
      if (value === null || typeof value !== 'object') {
        // 中间节点不存在或不是对象时，点路径无法继续深入解析
        return undefined;
      }
      value = (value as Record<string, unknown>)[part];
    }
    return value as T | undefined;
  }

  /**
   * 获取启动引导传入的原始参数
   * @returns 引导选项 BootstrapOptions
   */
  getBootstrapOptions(): BootstrapOptions {
    return this.options;
  }

  /**
   * 是否为本地开发环境 (local)
   */
  isLocal(): boolean {
    return this.environment === 'local';
  }

  /**
   * 是否为测试/预发环境 (beta)
   */
  isBeta(): boolean {
    return this.environment === 'beta';
  }

  /**
   * 是否为生产环境 (production)
   */
  isProduction(): boolean {
    return this.environment === 'production';
  }

  /**
   * 加载指定路径的配置文件，文件缺失时安全返回空对象
   *
   * @param filePath 配置文件绝对路径
   * @returns 加载得到的配置对象或空对象
   */
  private loadConfig(filePath: string): Record<string, unknown> {
    return existsSync(filePath) ? runtimeRequire(filePath) : {};
  }
}
