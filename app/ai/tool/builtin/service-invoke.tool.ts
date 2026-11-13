import type { BuiltinToolFactory } from '../tool.interface';
import type { ModuleRef } from '@nestjs/core';

/**
 * service-invoke 工具期望的结构化入参契约
 */
interface ServiceInvokeInput {
  /** 目标 Nest Provider 的注入 Token 或类名（如 'ProjectService'） */
  service: string;
  /** 目标 Service 实例上需要调用的具体方法名（如 'getProjectDetail'） */
  method: string;
  /** 传递给目标方法的位置参数数组（按函数声明顺序排列） */
  args: unknown[];
}

/**
 * NestJS 容器内部 ProviderWrapper 的最小类型结构
 * 用于在按类名反射检索 Service 实例时进行元数据匹配
 */
interface ProviderWrapper {
  /** 真实的注入 Token，可能是字符串、Symbol 或类构造函数 */
  token?: string | symbol | Function;
  /** 类 Provider 的构造函数元数据，用于获取类名 */
  metatype?: { name?: string };
  /** 已实例化的 Provider 单例引用 */
  instance?: Record<string, unknown>;
}

/**
 * ModuleRef 内部包含 Nest 容器的最小只读接口
 * 供反射查找模块下的全部 providers
 */
interface ModuleRefWithContainer {
  container?: {
    getModules(): Map<unknown, {
      providers: Map<unknown, ProviderWrapper>;
    }>;
  };
}

/**
 * 解析并校验传入 service-invoke 的入参
 *
 * @param input 原始输入数据
 * @returns 校验通过的结构化入参 ServiceInvokeInput
 * @throws 当输入格式不符合要求时抛出 Error
 */
function parseInput(input: unknown): ServiceInvokeInput {
  if (input === null || typeof input !== 'object') {
    throw new Error('service-invoke input must be an object');
  }

  const { service, method, args = [] } = input as Partial<ServiceInvokeInput>;
  if (typeof service !== 'string' || !service) {
    throw new Error('service-invoke requires a non-empty service');
  }
  if (typeof method !== 'string' || !method) {
    throw new Error('service-invoke requires a non-empty method');
  }
  if (!Array.isArray(args)) {
    throw new Error('service-invoke args must be an array');
  }

  return { service, method, args };
}

/**
 * 依据 Service 标识字符串在 NestJS 容器中定位对应的 Service 实例
 *
 * 【查找策略】
 * 1. 优先尝试使用 ModuleRef.get(service, { strict: false })，以兼容按字符串 Token 显式注册的 Provider；
 * 2. 若未直接命中，则遍历 Nest Container 中所有已加载模块的 providers 映射表：
 *    - 比较 ProviderWrapper 的构造器类名（metatype.name 或 instance.constructor.name）；
 *    - 若名称匹配且已实例化，直接返回该 instance；
 *    - 若尚未实例化但有 token，则通过 moduleRef.get(token) 进行解析获取。
 *
 * @param moduleRef Nest 模块引用
 * @param service 目标 Service 名称
 * @returns 目标 Service 实例，未找到则返回 undefined
 */
function resolveService(moduleRef: ModuleRef, service: string): Record<string, unknown> | undefined {
  try {
    // 针对显式使用字符串 Token 绑定的 Provider，直接获取
    return moduleRef.get<Record<string, unknown>>(service, { strict: false });
  } catch {
    // 按类注册的 Provider 其 Token 为类构造函数本身，继续走容器遍历流程
  }

  const container = (moduleRef as unknown as ModuleRefWithContainer).container;
  // 若当前执行环境（例如单测替身）中无真实容器，则安全返回 undefined
  if (!container) {
    return undefined;
  }

  // 遍历全局所有加载的 Nest 模块
  for (const module of container.getModules().values()) {
    for (const wrapper of module.providers.values()) {
      // 优先从元数据 metatype 读取类名，次选从已创建实例的构造器读取
      const providerName = wrapper.metatype?.name ?? wrapper.instance?.constructor.name;
      if (providerName !== service) {
        continue;
      }
      if (wrapper.instance) {
        // 单例作用域实例已就绪，直接复用
        return wrapper.instance;
      }
      if (wrapper.token !== undefined) {
        // 尚未直接持有实例时，通过底层 token 由 Nest 容器实例化解析
        return moduleRef.get<Record<string, unknown>>(wrapper.token, { strict: false });
      }
    }
  }
  return undefined;
}

/**
 * 内置工具：反射调用已注册 Nest Service 的方法 (service-invoke)
 *
 * 【设计定位】
 * 允许 Agent 或 Planner 在获得相应权限后，以受控方式调用业务工程中已经通过 Nest 容器管理的 Service，
 * 无需为每个业务方法手写繁琐的 Tool 包装。
 */
const serviceInvokeTool: BuiltinToolFactory = ({ moduleRef }) => ({
  name: 'service-invoke',
  description: '调用已注册 Service 的指定方法。',
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      service: {
        type: 'string',
        description: '目标 Service 的类名或注册标识，例如 "ProjectService"',
      },
      method: {
        type: 'string',
        description: '目标 Service 上可调用的成员方法名称',
      },
      args: {
        type: 'array',
        items: {},
        description: '调用目标方法的位置实参数组',
      },
    },
    required: ['service', 'method', 'args'],
  },
  /**
   * 执行方法调用
   *
   * @param input 工具入参
   * @returns 目标 Service 方法执行后的返回值
   */
  async execute(input: unknown): Promise<unknown> {
    // 校验入参格式
    const { service, method, args } = parseInput(input);

    // 从容器中解析目标 Service 实例
    const instance = resolveService(moduleRef, service);
    if (!instance) {
      throw new Error(`Service "${service}" is not registered`);
    }

    // 检查目标方法是否存在且为函数
    const target = instance[method];
    if (typeof target !== 'function') {
      throw new Error(`Method "${method}" is not available on service "${service}"`);
    }

    // 绑定 this 为目标实例并执行调用
    return target.apply(instance, args);
  },
});

export default serviceInvokeTool;
