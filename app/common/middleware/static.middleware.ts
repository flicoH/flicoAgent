import type { INestApplication } from '@nestjs/common';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import path from 'node:path';

function shouldBypassStatic(rawUrl: string): boolean {
  const pathname = rawUrl.split('?')[0] ?? '';
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  const normalized = decoded.toLowerCase();
  return normalized === '/api' || normalized.startsWith('/api/')
    || normalized === '/view' || normalized.startsWith('/view/');
}

function createScopedStatic(root: string): express.RequestHandler {
  const handler = express.static(root, {
    fallthrough: true,
    redirect: false,
  });
  return (req: Request, res: Response, next: NextFunction) => {
    if (shouldBypassStatic(req.url || req.originalUrl || '')) {
      next();
      return;
    }
    handler(req, res, next);
  };
}

export function applyStaticAssets(app: INestApplication): void {
  const httpApp: express.Express = app.getHttpAdapter().getInstance();
  httpApp.use(createScopedStatic(path.resolve(__dirname, '../../../app/public')));
  httpApp.use(createScopedStatic(path.resolve(process.cwd(), 'app/public')));
}
