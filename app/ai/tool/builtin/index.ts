import type { BuiltinToolFactory } from '../tool.interface';
import retrieveTool from './retrieve.tool';

/**
 * 框架内置工具工厂清单 (builtinTools)
 *
 * 【扩展方式】
 * 后续若需新增框架级内置工具：
 * 1. 在 `builtin/` 目录下新增 `*.tool.ts` 文件并遵循 `BuiltinToolFactory` 规范；
 * 2. 在本数组中追加导出即可，`ToolRegistryService` 将在初始化时统一实例化注册。
 */
export const builtinTools: BuiltinToolFactory[] = [
  retrieveTool,
];
