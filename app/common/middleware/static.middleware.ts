import type { INestApplication } from '@nestjs/common';
import express from 'express';
import path from 'node:path';

export function applyStaticAssets(app: INestApplication): void {
  const httpApp: express.Express = app.getHttpAdapter().getInstance();
  httpApp.use(express.static(path.resolve(__dirname, '../../../app/public'), {
    fallthrough: true,
    redirect: false,
  }));
  httpApp.use(express.static(path.resolve(process.cwd(), 'app/public'), {
    fallthrough: true,
    redirect: false,
  }));
}
