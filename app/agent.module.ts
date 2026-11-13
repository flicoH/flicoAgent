import { Module } from '@nestjs/common';
import type { DynamicModule, INestApplication, Type } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { AiModule } from './ai/ai.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ApiSignGuard } from './common/guards/api-sign.guard';
import { applyStaticAssets } from './common/middleware/static.middleware';
import { ExtendModule } from './extend/extend.module';
import { ProjectModule } from './modules/project/project.module';
import { ViewModule } from './modules/view/view.module';
import { FallbackModule } from './modules/fallback/fallback.module';

// 用于在 ESM / CJS 混合环境下动态加载模块文件
const runtimeRequire = createRequire(__filename);

/**
 * 扫描业务工程构建产物中的 Nest 业务模块
 *
 * 【工作机制】
 * 1. 判断当前执行根目录 (process.cwd()) 与框架根目录是否一致，若一致说明在框架本身内运行，不进行业务扫描；
 * 2. 扫描业务工程下的 `dist/modules` 目录，递归匹配所有 `*.module.js` 文件；
 * 3. 动态 require 模块文件，通过反射检查类上是否包含 Nest 模块元数据 (imports, controllers, providers, exports)；
 * 4. 去重后返回符合条件的模块类列表。
 *
 * @returns 业务模块类列表
 */
function scanBusinessModules(): Type[] {
  const businessRoot = resolve(process.cwd());
  const frameworkRoot = resolve(__dirname, '..');
  // 框架开发/测试自身 cwd 时，不扫描自身 dist/modules，源码不硬编码业务模块
  if (businessRoot === frameworkRoot) {
    return [];
  }

  const modulesRoot = resolve(businessRoot, 'dist/modules');
  if (!existsSync(modulesRoot)) {
    return [];
  }
  const moduleFiles = readdirSync(modulesRoot, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.module.js'))
    .map(entry => resolve(entry.parentPath, entry.name))
    .sort();
  const modules = moduleFiles.flatMap(file => Object.values(runtimeRequire(file)))
    .filter((value): value is Type => (
      typeof value === 'function'
      && ['imports', 'controllers', 'providers', 'exports']
        .some(key => Reflect.hasMetadata(key, value))
    ));

  return [...new Set(modules)];
}

/**
 * agent 核心根模块
 *
 * 【职责】
 * 负责组装底层全局能力、框架内置模块（AI、项目、视图）、动态扫描导入的业务模块，
 * 以及设置全局异常过滤器 (HttpExceptionFilter) 和 API 验签守卫 (ApiSignGuard)。
 */
export class agentModule {
  /**
   * 注册 agent 动态模块
   * 按照严格的装配顺序组织 imports 列表：
   * 1. AiModule (AI Agent 运行时)
   * 2. ExtendModule (logger, db 等扩展提供者)
   * 3. ProjectModule (项目管理能力)
   * 4. ViewModule (视图路由)
   * 5. ...scanBusinessModules() (业务工程自定义的业务模块)
   * 6. FallbackModule (兜底路由匹配，必须置于末尾)
   */
  static register(): DynamicModule {
    return {
      module: agentModule,
      imports: [
        AiModule,
        ExtendModule,
        ProjectModule,
        ViewModule,
        ...scanBusinessModules(),
        // 兜底路由必须位于最后，处理未命中的页面 302 重定向
        FallbackModule,
      ],
      providers: [
        // 全局 HTTP 异常过滤器
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
        // 全局 API Guard，兼容业务接口验签并为 AI 接口执行独立授权。
        { provide: APP_GUARD, useClass: ApiSignGuard },
      ],
    };
  }

  /**
   * 配置静态资源托管中间件
   * @param app Nest 应用实例
   */
  static configureStatic(app: INestApplication): void {
    applyStaticAssets(app);
  }
}

// 静态动态模块自注册到元数据，支持 NestFactory 直接作为根模块启动
const registeredModule = agentModule.register();
Module({
  imports: registeredModule.imports,
  providers: registeredModule.providers,
})(agentModule);
