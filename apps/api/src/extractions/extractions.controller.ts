import {
  Body,
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  CreateExtractionSchema,
  ExtractionIdSchema,
  ExtractionListQuerySchema,
  IdempotencyKeySchema,
  type Auth0User,
  type CreateExtraction,
  type ExtractionJob,
  type ExtractionListQuery,
  type ExtractionListResponse,
} from '@extractionstack/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import type { ExtractionsService } from './extractions.service.js';

interface AuthenticatedRequest {
  user: Auth0User;
}

@Controller('api/extractions')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('user', 'admin')
export class ExtractionsController {
  constructor(private readonly service: ExtractionsService) {}

  @Post()
  @HttpCode(202)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  create(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(CreateExtractionSchema)) body: CreateExtraction,
    @Headers('idempotency-key') rawIdempotencyKey: string | undefined,
  ): Promise<ExtractionJob> {
    const parsedKey = IdempotencyKeySchema.safeParse(rawIdempotencyKey);
    if (!parsedKey.success) {
      throw new BadRequestException({
        code: 'VALIDATION',
        message: 'invalid idempotency key',
      });
    }
    return this.service.create(request.user, body, parsedKey.data);
  }

  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(ExtractionListQuerySchema)) query: ExtractionListQuery,
  ): Promise<ExtractionListResponse> {
    return this.service.list(request.user, query);
  }

  @Get(':id')
  get(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ZodValidationPipe(ExtractionIdSchema)) id: string,
  ): Promise<ExtractionJob> {
    return this.service.get(request.user, id);
  }

  @Post(':id/cancel')
  cancel(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ZodValidationPipe(ExtractionIdSchema)) id: string,
  ): Promise<ExtractionJob> {
    return this.service.cancel(request.user, id);
  }
}
