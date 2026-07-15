import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import type { ExtractRequest, ExtractionReport } from '@extractionstack/shared';
import { ExtractRequestSchema } from '@extractionstack/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import type { ExtractService } from './extract.service.js';

@Controller('api')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ExtractController {
  constructor(private readonly service: ExtractService) {}

  @Post('extract')
  @HttpCode(200)
  @Roles('user', 'admin')
  async extract(
    @Body(new ZodValidationPipe(ExtractRequestSchema)) body: ExtractRequest,
  ): Promise<ExtractionReport> {
    return this.service.extract(body);
  }
}
