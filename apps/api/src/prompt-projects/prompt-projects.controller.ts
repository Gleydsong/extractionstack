import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  IdempotencyKeySchema,
  PromptAdaptationRequestSchema,
  PromptGenerationRequestSchema,
  PromptPreviewRequestSchema,
  PromptProjectListQuerySchema,
  PromptWizardInputSchema,
  PublicIdSchema,
  type Auth0User,
  type PromptAdaptationRequest,
  type PromptGenerationJob,
  type PromptGenerationRequest,
  type PromptPreviewRequest,
  type PromptProject,
  type PromptProjectListQuery,
  type PromptProjectListResponse,
  type PromptWizardInput,
} from '@extractionstack/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PromptProjectsService } from './prompt-projects.service.js';

interface AuthenticatedRequest {
  user: Auth0User;
}

@Controller('api/prompt-projects')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('user', 'admin')
export class PromptProjectsController {
  constructor(@Inject(PromptProjectsService) private readonly service: PromptProjectsService) {}

  @Post()
  @HttpCode(201)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  create(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(PromptWizardInputSchema)) body: PromptWizardInput,
    @Headers('idempotency-key') rawKey: string | undefined,
  ): Promise<PromptProject> {
    return this.service.create(request.user, body, requireIdempotencyKey(rawKey));
  }

  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(PromptProjectListQuerySchema)) query: PromptProjectListQuery,
  ): Promise<PromptProjectListResponse> {
    return this.service.list(request.user, query);
  }

  @Get(':id')
  get(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ZodValidationPipe(PublicIdSchema)) id: string,
  ): Promise<PromptProject> {
    return this.service.get(request.user, id);
  }

  @Post(':id/generations')
  @HttpCode(202)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  generate(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ZodValidationPipe(PublicIdSchema)) id: string,
    @Body(new ZodValidationPipe(PromptGenerationRequestSchema)) body: PromptGenerationRequest,
    @Headers('idempotency-key') rawKey: string | undefined,
  ): Promise<PromptGenerationJob> {
    return this.service.generate(request.user, id, body, requireIdempotencyKey(rawKey));
  }
}

@Controller('api/prompt-versions')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('user', 'admin')
export class PromptVersionsController {
  constructor(@Inject(PromptProjectsService) private readonly service: PromptProjectsService) {}

  @Post(':id/adaptations')
  @HttpCode(202)
  adapt(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ZodValidationPipe(PublicIdSchema)) id: string,
    @Body(new ZodValidationPipe(PromptAdaptationRequestSchema)) body: PromptAdaptationRequest,
    @Headers('idempotency-key') rawKey: string | undefined,
  ): Promise<PromptGenerationJob> {
    return this.service.adapt(request.user, id, body, requireIdempotencyKey(rawKey));
  }

  @Post(':id/previews')
  @HttpCode(202)
  preview(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ZodValidationPipe(PublicIdSchema)) id: string,
    @Body(new ZodValidationPipe(PromptPreviewRequestSchema)) body: PromptPreviewRequest,
    @Headers('idempotency-key') rawKey: string | undefined,
  ): Promise<PromptGenerationJob> {
    return this.service.preview(request.user, id, body, requireIdempotencyKey(rawKey));
  }
}

@Controller('api/prompt-jobs')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('user', 'admin')
export class PromptJobsController {
  constructor(@Inject(PromptProjectsService) private readonly service: PromptProjectsService) {}

  @Get(':id')
  get(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ZodValidationPipe(PublicIdSchema)) id: string,
  ): Promise<PromptGenerationJob> {
    return this.service.getJob(request.user, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ZodValidationPipe(PublicIdSchema)) id: string,
    @Headers('idempotency-key') rawKey: string | undefined,
  ): Promise<PromptGenerationJob> {
    return this.service.cancel(request.user, id, requireIdempotencyKey(rawKey));
  }
}

function requireIdempotencyKey(value: string | undefined): string {
  const parsed = IdempotencyKeySchema.safeParse(value);
  if (!parsed.success) {
    throw new BadRequestException({ code: 'VALIDATION', message: 'invalid idempotency key' });
  }
  return parsed.data;
}
