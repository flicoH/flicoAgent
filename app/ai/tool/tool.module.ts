import { Module } from '@nestjs/common';
import { ToolRegistryService } from './tool-registry.service';

/**
 * 通用工具模块 (ToolModule)
 *
 * 【职责】
 * 封装通用工具注册表服务：
 * 1. 实例化 `ToolRegistryService` 并自动装配所有框架内置工具（如 service-invoke）；
 * 2. 导出 `ToolRegistryService`，向 `AiController` 暴露查询端点，向 `RuntimeModule` 提供工具调度支持。
 */
@Module({
  providers: [ToolRegistryService],
  exports: [ToolRegistryService],
})
export class ToolModule {}
