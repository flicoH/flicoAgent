/*
 * ********************************************************************************************** 
 *  CopyRight (C) 2026 huangqinjia(flicoH)。 
 *  Rights Reserved. 
 *  其他任何个人、公司不得使用、复制、传播、修改或商业使用。
 * **********************************************************************************************
 * @Date: 2026-10-22 13:12:41
 * @LastEditors: flicoH
 * @LastEditTime: 2026-11-06 12:33:05
 */
import { Module } from '@nestjs/common';
import { SkillScannerService } from './skill-scanner.service';

/** 组装 Skill 扫描能力，并向 AiController 等调用方导出注册表服务。 */
@Module({
  // Nest 在创建 Service 后会触发其 onModuleInit 扫描逻辑。
  providers: [SkillScannerService],
  // 导出后，导入 SkillModule 的 AiModule 可以注入该 Service。
  exports: [SkillScannerService],
})
export class SkillModule {}