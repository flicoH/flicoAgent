import { Injectable } from '@nestjs/common';
import Ajv from 'ajv';
import { ExecutionResult } from '../contracts';
import type { SkillDefinition } from '../skill/skill.interface';
import { SkillScannerService } from '../skill/skill-scanner.service';
import type { ToolDefinition } from './tool.interface';
import { ToolRegistryService } from './tool-registry.service';

export class CapabilityApprovalRequired extends Error {
  readonly code = 'CAPABILITY_APPROVAL_REQUIRED';

  constructor(
    readonly kind: 'skill' | 'tool',
    readonly capabilityName: string,
    readonly input: unknown,
  ) {
    super(`Capability "${capabilityName}" requires approval before execution`);
    this.name = 'CapabilityApprovalRequired';
  }
}

export class CapabilityInputInvalid extends Error {
  readonly code = 'INVALID_CAPABILITY_INPUT';

  constructor(
    readonly capabilityName: string,
    message: string,
  ) {
    super(message);
    this.name = 'CapabilityInputInvalid';
  }
}

export interface ExecuteOptions {
  approved?: boolean;
  checkApproval?: boolean;
}

/**
 * 能力执行器服务 (ExecutorService)
 *
 * 【调度执行中枢】
 * 1. 按 Agent 白名单匹配 Skill（优先）或 Tool；
 * 2. 执行前通过 ajv 校验 inputSchema，不合法时返回 INVALID_CAPABILITY_INPUT 观察错误；
 * 3. 对声明 approval: 'required' 的能力强制执行审批拦截（委派运行直接拒绝，主运行抛出 CapabilityApprovalRequired 供编排器挂起）；
 * 4. 提供 invokeSkill 直调入口，禁止通过直调绕过审批与 Schema 校验。
 */
@Injectable()
export class ExecutorService {
  private readonly ajv = new Ajv({ allErrors: true, coerceTypes: false });
  private readonly validatorCache = new WeakMap<object, Ajv.ValidateFunction>();

  constructor(
    private readonly skills: SkillScannerService,
    private readonly tools: ToolRegistryService,
  ) {}

  /**
   * 直接调用 Skill（供 HTTP 直调端点或业务层使用）。
   * 同步检查 approval === 'required'，避免任何调用方绕过审批门禁。
   */
  invokeSkill(
    skill: SkillDefinition,
    input: unknown,
    context: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (skill.approval === 'required') {
      throw new CapabilityApprovalRequired('skill', skill.name, input);
    }
    const validationError = this.validateInput(skill.name, skill.inputSchema, input);
    if (validationError) {
      throw new CapabilityInputInvalid(skill.name, validationError);
    }
    return Promise.resolve().then(() => skill.execute(input, context));
  }

  /**
   * 预检能力归属、白名单与审批声明
   */
  resolveCapability(
    name: string,
    permissions?: { skills: string[]; tools: string[] },
  ): { kind: 'skill'; definition: SkillDefinition } | { kind: 'tool'; definition: ToolDefinition } | null {
    const skillAllowed = !permissions || permissions.skills.includes(name);
    const toolAllowed = !permissions || permissions.tools.includes(name);
    const skill = skillAllowed ? this.skills.get(name) : undefined;
    if (skill) return { kind: 'skill', definition: skill };
    const tool = toolAllowed ? this.tools.get(name) : undefined;
    if (tool) return { kind: 'tool', definition: tool };
    return null;
  }

  /**
   * 执行指定名称的能力（Skill 或 Tool）
   */
  async execute(
    name: string,
    input: unknown,
    context: Record<string, unknown>,
    permissions?: { skills: string[]; tools: string[] },
    delegated = false,
    options?: ExecuteOptions,
  ): Promise<ExecutionResult> {
    const skillAllowed = !permissions || permissions.skills.includes(name);
    const toolAllowed = !permissions || permissions.tools.includes(name);

    const skill = skillAllowed ? this.skills.get(name) : undefined;
    if (skill) {
      const validationError = this.validateInput(name, skill.inputSchema, input);
      if (validationError) {
        return this.invalidInputError(name, validationError);
      }
      if (skill.approval === 'required') {
        if (delegated) {
          return this.delegatedApprovalError(name);
        }
        if (options?.checkApproval && !options.approved) {
          throw new CapabilityApprovalRequired('skill', name, input);
        }
      }
      try {
        return {
          type: 'skill',
          name,
          output: await skill.execute(input, context),
        };
      } catch (error) {
        return this.executionError(name, error);
      }
    }

    const tool = toolAllowed ? this.tools.get(name) : undefined;
    if (tool) {
      const validationError = this.validateInput(name, tool.inputSchema, input);
      if (validationError) {
        return this.invalidInputError(name, validationError);
      }
      if (tool.approval === 'required') {
        if (delegated) {
          return this.delegatedApprovalError(name);
        }
        if (options?.checkApproval && !options.approved) {
          throw new CapabilityApprovalRequired('tool', name, input);
        }
      }
      try {
        return {
          type: 'tool',
          name,
          source: tool.source ?? 'builtin',
          output: await tool.execute(input, context),
        };
      } catch (error) {
        return this.executionError(name, error);
      }
    }

    return {
      type: 'observe',
      name,
      error: {
        code: skillAllowed || toolAllowed ? 'CAPABILITY_NOT_FOUND' : 'CAPABILITY_NOT_ALLOWED',
        message: skillAllowed || toolAllowed
          ? `Skill or tool "${name}" is not registered`
          : `Skill or tool "${name}" is unavailable to this Agent`,
      },
    };
  }

  validateInput(name: string, schema: unknown, input: unknown): string | null {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      return null;
    }
    const schemaObj = schema as Record<string, unknown>;
    if (Object.keys(schemaObj).length === 0) {
      return null;
    }
    let validator = this.validatorCache.get(schemaObj);
    if (!validator) {
      try {
        validator = this.ajv.compile(schemaObj);
        this.validatorCache.set(schemaObj, validator);
      } catch {
        return null;
      }
    }
    const valid = validator(input);
    if (valid) {
      return null;
    }
    const detail = this.ajv.errorsText(validator.errors);
    return `Invalid input for "${name}": ${detail}`;
  }

  private invalidInputError(name: string, message: string): ExecutionResult {
    return {
      type: 'observe',
      name,
      error: { code: 'INVALID_CAPABILITY_INPUT', message },
    };
  }

  private delegatedApprovalError(name: string): ExecutionResult {
    return {
      type: 'observe',
      name,
      error: { code: 'DELEGATE_APPROVAL_REQUIRED', message: 'Delegated runs cannot request approval' },
    };
  }

  private executionError(name: string, error: unknown): ExecutionResult {
    return {
      type: 'observe',
      name,
      error: {
        code: 'EXECUTION_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
