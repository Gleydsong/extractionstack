import type {
  ArgumentMetadata,
  PipeTransform} from '@nestjs/common';
import {
  BadRequestException,
  Injectable
} from '@nestjs/common';
import type { ZodSchema } from 'zod';

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const fields = result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      }));
      throw new BadRequestException({
        code: 'VALIDATION',
        message: 'request validation failed',
        fields,
      });
    }
    return result.data;
  }
}
