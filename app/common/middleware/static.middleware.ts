import type { INestApplication } from '@nestjs/common';
import express from 'express';
import path from 'node:path';

export function applyStaticAssets(app: INestApplication): void {
  const httpApp: express.Express = app.getHttpAdapter().getInstance();
  for (const root of [path.resolve(__dirname, '../../../app/public'), path.resolve(process.cwd(), 'app/public')]) {
    const assets = express.static(root, { fallthrough: true, redirect: false });
    httpApp.use((request, response, next) => {
      // 静态资源在 Nest Guard 之前运行。API 路径始终由 Nest 路由处理。
      let pathname = (request.path ?? request.url).split('?')[0];
      try {
        pathname = decodeURIComponent(pathname);
      } catch {
        // URL 编码不合法时由路由层处理。
        return next();
      }
      if (/^\/api(?:\/|$)/i.test(path.posix.normalize(pathname))) return next();
      return assets(request, response, next);
    });
  }
}
