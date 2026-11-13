import { HttpException, HttpStatus, Injectable, ValidationPipe } from '@nestjs/common';
import type { ValidationError } from 'class-validator';

function validationMessages(errors: ValidationError[], parent = ''): string[] {
  return errors.flatMap(error => {
    const property = [parent, error.property].filter(Boolean).join('.');
    const messages = Object.values(error.constraints ?? {}).map(message =>
      parent ? `${property}: ${message}` : message,
    );
    return [...messages, ...validationMessages(error.children ?? [], property)];
  });
}

@Injectable()
export class RequestValidationPipe extends ValidationPipe {
  constructor() {
    super({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      forbidUnknownValues: true,
      skipMissingProperties: false,
      validationError: { target: false, value: false },
      exceptionFactory: errors => new HttpException({
        success: false,
        message: `request validate fail: ${validationMessages(errors).join('; ') || 'invalid request parameters'}`,
        code: 442,
      }, HttpStatus.OK),
    });
  }
}
