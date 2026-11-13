import { DynamicModule, Module } from '@nestjs/common';
import { BootstrapOptions } from './config/bootstrap-options';
import { ConfigModule } from './config/config.module';
import { agentModule } from './agent.module';

@Module({})
export class AppModule {
  static register(options: BootstrapOptions = {}): DynamicModule {
    return {
      module: AppModule,
        imports: [ConfigModule.register(options), agentModule.register()],
    };
  }
}
