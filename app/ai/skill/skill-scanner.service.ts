import { DELEGATE_TOOL } from '../runtime/internal/delegation';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { SkillDefinition } from './skill.interface';

// 用于动态加载业务 demo 构建后的 Skill CommonJS 模块
const runtimeRequire = createRequire(__filename);
// glob@7 未自带当前项目的 TS 类型声明，在此显式约束 sync 函数签名
const globSync = (runtimeRequire('glob') as { sync(pattern: string): string[] }).sync;

/**
 * 业务 Skill 动态模块的形状约束
 * 业务 Skill 必须通过 default export 导出实现
 */
interface SkillModule {
  default?: unknown;
}

/**
 * 转换成 OpenAI 兼容规范的 Function Calling 工具描述结构
 */
export interface SkillToolPayload {
  /** OpenAI tools 目前规范类型固定为 'function' */
  type: 'function';
  function: {
    /** 对应 SkillDefinition.name，即函数名 */
    name: string;
    /** 对应 SkillDefinition.description，即函数功能描述 */
    description: string;
    /** 对应 SkillDefinition.inputSchema，即函数的入参 JSON Schema */
    parameters: unknown;
  };
}

/**
 * 运行时校验动态加载的对象是否符合 SkillDefinition 的契约
 *
 * 【运行时结构校验】
 * - 必须为非 null 的对象；
 * - 包含非空字符串属性 name；
 * - 包含字符串属性 description；
 * - 包含 inputSchema 属性（这里只检查属性存在，不验证 Schema 本身）；
 * - 包含异步或同步可执行函数 execute。
 *
 * @param value 待校验对象
 * @returns 是否符合 SkillDefinition
 */
function isSkillDefinition(value: unknown): value is SkillDefinition {
  return value !== null
    && typeof value === 'object'
    && typeof (value as Partial<SkillDefinition>).name === 'string'
    && Boolean((value as Partial<SkillDefinition>).name)
    && (value as Partial<SkillDefinition>).name !== DELEGATE_TOOL
    && typeof (value as Partial<SkillDefinition>).description === 'string'
    && ((value as Partial<SkillDefinition>).approval === undefined || (value as Partial<SkillDefinition>).approval === 'required')
    && 'inputSchema' in value
    && typeof (value as Partial<SkillDefinition>).execute === 'function';
}

/**
 * 业务技能扫描与注册服务 (SkillScannerService)
 *
 * 【核心职责】
 * 在 Nest 应用生命周期初始化 (onModuleInit) 时自动发现并校验业务 demo 中的 Skill：
 * 1. 扫描路径：`dist/skills/**\/*.skill.js`；
 * 2. 检查声明字段和执行函数，严禁重名冲突；
 * 3. 维护内部技能 Map，供 Controller 直接触发或供 Executor 动态调度；
 * 4. 提供 `toToolsPayload` 方法，自动将 Skill 转换为大模型兼容的 function calling 结构。
 */
@Injectable()
export class SkillScannerService implements OnModuleInit {
  /** 维护技能名称到技能定义实现的内存映射表 */
  private readonly skills = new Map<string, SkillDefinition>();

  /**
   * 模块初始化生命周期：执行全量业务 Skill 扫描
   */
  onModuleInit(): void {
    // process.cwd() 指向业务 demo，框架只扫描业务工程的 dist 产物
    const pattern = resolve(process.cwd(), 'dist/skills/**/*.skill.js');

    for (const filePath of globSync(pattern)) {
      // 约定仅读取 default export，过滤其他辅助导出
      const loaded = runtimeRequire(filePath) as SkillModule;
      const skill = loaded.default;

      // 若任一字段不满足契约，启动阶段直接抛错终止，防止运行时发生不可预期故障
      if (!isSkillDefinition(skill)) {
        throw new Error(`Invalid default SkillDefinition export: ${filePath}`);
      }
      if (this.skills.has(skill.name)) {
        // 技能名作为模型调用的核心唯一标识，禁止同名静默覆盖
        throw new Error(`Duplicate skill name "${skill.name}": ${filePath}`);
      }

      // 校验合法后录入注册表
      this.skills.set(skill.name, skill);
    }

    // 输出控制台日志，便于核对已识别的技能列表
    console.log('[SkillScanner] registered skills:', [...this.skills.keys()]);
    // 打印转换后的大模型 tools 描述负载预览
    console.log('[SkillScanner] tools payload:', JSON.stringify(this.toToolsPayload()));
  }

  /**
   * 根据技能名获取对应的 Skill 定义实现
   *
   * @param name 技能注册名
   * @returns 匹配的 SkillDefinition，未注册则返回 undefined
   */
  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  /**
   * 将当前所有注册的 Skill 转换为符合 OpenAI Function Calling 规范的工具描述列表
   *
   * 【安全性说明】
   * 只提取 name、description、inputSchema 等元数据，排除了本地代码 execute 实现，确保可安全序列化并发送至模型
   *
   * @returns 工具声明数组
   */
  toToolsPayload(): SkillToolPayload[] {
    return [...this.skills.values()].map(skill => ({
      type: 'function',
      function: {
        name: skill.name,
        description: skill.description,
        parameters: skill.inputSchema,
      },
    }));
  }
}
