import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ElpisModule } from './elpis.module';
import { RequestValidationPipe } from './common/validation/request-validation.pipe';
import { ProjKeyInterceptor } from './common/interceptors/proj-key.interceptor';
import { BootstrapOptions } from './config/bootstrap-options';

export async function bootstrap(options: BootstrapOptions = {}) {
  const app = await NestFactory.create(AppModule.register(options));
  ElpisModule.configureStatic(app);
  app.useGlobalPipes(new RequestValidationPipe());
  app.useGlobalInterceptors(new ProjKeyInterceptor());
  await app.listen(8080);
  return app;
}
