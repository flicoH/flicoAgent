import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ElpisModule } from './elpis.module';
import { RequestValidationPipe } from './common/validation/request-validation.pipe';
import { ProjKeyInterceptor } from './common/interceptors/proj-key.interceptor';
import { BootstrapOptions } from './config/bootstrap-options';
import { ConfigService } from './config/config.service';

export function resolveListenPort(
  optionsPort?: number,
  configPort?: unknown,
  envPort: string | undefined = process.env.PORT,
): number {
  const candidates = [optionsPort, configPort, envPort];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === '') continue;
    const numeric = typeof candidate === 'number' ? candidate : Number(String(candidate).trim());
    if (Number.isInteger(numeric) && numeric >= 0 && numeric <= 65535) {
      return numeric;
    }
    throw new Error(`Invalid server port "${String(candidate)}"`);
  }
  return 8080;
}

export async function bootstrap(options: BootstrapOptions = {}) {
  const app = await NestFactory.create(AppModule.register(options), { rawBody: true });
  ElpisModule.configureStatic(app);
  app.useGlobalPipes(new RequestValidationPipe());
  app.useGlobalInterceptors(new ProjKeyInterceptor());
  if (options.shutdownHooks !== false && typeof app.enableShutdownHooks === 'function') {
    app.enableShutdownHooks();
  }

  const config = typeof app.get === 'function' ? app.get(ConfigService) : undefined;
  const port = resolveListenPort(options.port, config?.get('port'));
  const host = options.host ?? config?.get<string>('host');
  if (typeof host === 'string' && host.trim()) {
    await app.listen(port, host.trim());
  } else {
    await app.listen(port);
  }
  return app;
}
