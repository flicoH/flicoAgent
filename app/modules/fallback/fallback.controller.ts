import { Controller, Get, Redirect } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';

@Controller()
export class FallbackController {
  constructor(private readonly config: ConfigService) {}

  @Get('*')
  @Redirect()
  redirectToHome() {
    return {
      url: this.config.get<string>('homePage') ?? '/',
      statusCode: 302,
    };
  }
}
