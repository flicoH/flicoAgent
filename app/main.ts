import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { agentModule } from './agent.module';
import { RequestValidationPipe } from './common/validation/request-validation.pipe';
import { ProjKeyInterceptor } from './common/interceptors/proj-key.interceptor';
import { BootstrapOptions } from './config/bootstrap-options';

export async function bootstrap(options: BootstrapOptions = {}) {
  // 服务间 API 签名绑定原始请求体。保留原始字节避免 JSON 重序列化改变签名。
  const app = await NestFactory.create(AppModule.register(options), { rawBody: true });
  agentModule.configureStatic(app);
  app.useGlobalPipes(new RequestValidationPipe());
  app.useGlobalInterceptors(new ProjKeyInterceptor());
  await app.listen(8080);
  return app;
}
