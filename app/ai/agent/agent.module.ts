import { Module } from '@nestjs/common';
import { AgentScannerService } from './agent-scanner.service';

/**
 * Agent 声明模块 (AgentModule)
 *
 * 【职责】
 * 封装 Agent 声明的扫描与注册能力：
 * 1. 注册并初始化 `AgentScannerService`；
 * 2. 导出 `AgentScannerService`，供 `AiController` 和 `RuntimeModule` 使用。
 */
@Module({
  // Nest 初始化时将触发 AgentScannerService 的 onModuleInit 生命周期以扫描 Agent
  providers: [AgentScannerService],
  // 导出扫描服务，供上层控制器查询列表及运行时获取 Agent 编排元数据
  exports: [AgentScannerService],
})
export class AgentModule {}
