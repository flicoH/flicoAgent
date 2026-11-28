import { ModulesContainer } from '@nestjs/core';
import { ConfigService } from '../../../config/config.service';
import type { BuiltinToolDeps, ToolDefinition } from '../tool.interface';

interface ServiceInvokeInput {
  service: string;
  method: string;
  args?: unknown[];
}

function resolveServiceInstance(deps: BuiltinToolDeps, serviceName: string): Record<string, unknown> | undefined {
  try {
    const direct = deps.moduleRef.get<Record<string, unknown>>(serviceName, { strict: false });
    if (direct && typeof direct === 'object') {
      return direct;
    }
  } catch {
    // 非字符串 token，继续按类名从 ModulesContainer 解析
  }

  try {
    const container = deps.moduleRef.get(ModulesContainer, { strict: false });
    for (const moduleRef of container.values()) {
      for (const wrapper of moduleRef.providers.values()) {
        const metatypeName = typeof wrapper.metatype === 'function' ? wrapper.metatype.name : undefined;
        const instanceName = wrapper.instance && typeof wrapper.instance === 'object'
          ? (wrapper.instance as { constructor?: { name?: string } }).constructor?.name
          : undefined;
        if (metatypeName === serviceName || instanceName === serviceName || wrapper.name === serviceName) {
          if (wrapper.instance && typeof wrapper.instance === 'object') {
            return wrapper.instance as Record<string, unknown>;
          }
          try {
            const resolved = deps.moduleRef.get<Record<string, unknown>>(wrapper.token, { strict: false });
            if (resolved && typeof resolved === 'object') {
              return resolved;
            }
          } catch {
            // 忽略未实例化提供者
          }
        }
      }
    }
  } catch {
    // 容器不可用时安全返回 undefined
  }
  return undefined;
}

export default function createServiceInvokeTool(deps: BuiltinToolDeps): ToolDefinition {
  const getConfig = (): ConfigService | undefined => {
    try {
      return deps.moduleRef.get(ConfigService, { strict: false });
    } catch {
      return undefined;
    }
  };

  const config = getConfig();
  const requireApproval = config?.get<boolean>('ai.tools.serviceInvokeApproval') === true;

  return {
    name: 'service-invoke',
    ...(requireApproval ? { approval: 'required' as const } : {}),
    description: '调用经 ai.tools.serviceInvoke 白名单授权的 Nest 服务方法。',
    inputSchema: {
      type: 'object',
      required: ['service', 'method'],
      additionalProperties: false,
      properties: {
        service: { type: 'string', minLength: 1 },
        method: { type: 'string', minLength: 1 },
        args: { type: 'array' },
      },
    },
    source: 'builtin',
    async execute(rawInput: unknown): Promise<unknown> {
      const input = rawInput as ServiceInvokeInput;
      const allowlist = getConfig()?.get<Record<string, unknown>>('ai.tools.serviceInvoke');
      const methods = allowlist && typeof allowlist === 'object' && Object.hasOwn(allowlist, input.service)
        ? allowlist[input.service]
        : undefined;
      if (!Array.isArray(methods) || !methods.includes(input.method)) {
        throw new Error(`Service method "${input.service}.${input.method}" is not allowed`);
      }

      const instance = resolveServiceInstance(deps, input.service);
      if (!instance) {
        throw new Error(`Service "${input.service}" is not available`);
      }
      const fn = instance[input.method];
      if (typeof fn !== 'function') {
        throw new Error(`Method "${input.method}" does not exist on service "${input.service}"`);
      }
      const callArgs = Array.isArray(input.args) ? input.args : [];
      return fn.apply(instance, callArgs);
    },
  };
}
