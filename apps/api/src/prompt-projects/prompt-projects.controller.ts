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
  PromptCostEstimateRequestSchema,
  PromptAdaptationRequestSchema,
  PromptGenerationRequestSchema,
  PromptPreviewRequestSchema,
  PromptProjectListQuerySchema,
  PromptWizardInputSchema,
  PromptVersionEditRequestSchema,
  PromptVersionListQuerySchema,
  PublicIdSchema,
  type Auth0User,
  type PromptCostEstimate,
  type PromptCostEstimateRequest,
  type PromptAdaptationRequest,
  type PromptGenerationJob,
  type PromptGenerationRequest,
  type PromptPreviewRequest,
  type PromptProject,
  type PromptProjectListQuery,
  type PromptProjectListResponse,
  type PromptWizardInput,
  type PromptPreview,
  type PromptVersionDetail,
  type PromptVersionEditRequest,
  PromptVersionCostEstimateRequestSchema,
  type PromptVersionCostEstimate,
  type PromptVersionCostEstimateRequest,
  type PromptVersionListQuery,
  type PromptVersionListResponse,
} from '@extractionstack/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  LlmRateLimit,
  LlmRateLimitGuard,
  LlmRatePolicies,
} from '../common/llm-rate-limit.guard.js';
import { PromptProjectsService } from './prompt-projects.service.js';

interface AuthenticatedRequest {
  user: Auth0User;
}

@Controller('api/prompt-projects')
@UseGuards(JwtAuthGuard, RolesGuard, LlmRateLimitGuard)
@Roles('user', 'admin')
export class PromptProjectsController {
  constructor(@Inject(PromptProjectsService) private readonly service: PromptProjectsService) {}

  @Post('cost-estimate')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @LlmRateLimit(LlmRatePolicies.ESTIMATE)
  estimate(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(PromptCostEstimateRequestSchema)) body: PromptCostEstimateRequest,
  ): Promise<PromptCostEstimate> {
    return this.service.estimateCost(request.user, body);
  }

  @Post()
  @HttpCode(201)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @LlmRateLimit(LlmRatePolicies.PROJECT_CREATE)
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

  @Get(':id/versions')
  listVersions(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ZodValidationPipe(PublicIdSchema)) id: string,
    @Query(new ZodValidationPipe(PromptVersionListQuerySchema)) query: PromptVersionListQuery,
  ): Promise<PromptVersionListResponse> {
    return this.service.listVersions(request.user, id, query);
  }

  @Post(':id/generations')
  @HttpCode(202)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @LlmRateLimit(LlmRatePolicies.GENERATE)
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
@UseGuards(JwtAuthGuard, RolesGuard, LlmRateLimitGuard)
@Roles('user', 'admin')
export class PromptVersionsController {
  constructor(@Inject(PromptProjectsService) private readonly service: PromptProjectsService) {}

  @Get(':id')
  get(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ZodValidationPipe(PublicIdSchema)) id: string,
  ): Promise<PromptVersionDetail> {
    return this.service.getVersion(request.user, id);
  }

  @Post(':id/edits')
  @HttpCode(201)
  @LlmRateLimit(LlmRatePolicies.EDIT)
  edit(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ZodValidationPipe(PublicIdSchema)) id: string,
    @Body(new ZodValidationPipe(PromptVersionEditRequestSchema)) body: PromptVersionEditRequest,
    @Headers('idempotency-key') rawKey: string | undefined,
  ): Promise<PromptVersionDetail> {
    return this.service.editVersion(request.user, id, body, requireIdempotencyKey(rawKey));
  }

  @Post(':id/cost-estimate')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @LlmRateLimit(LlmRatePolicies.ESTIMATE)
  estimate(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ZodValidationPipe(PublicIdSchema)) id: string,
    @Body(new ZodValidationPipe(PromptVersionCostEstimateRequestSchema))
    body: PromptVersionCostEstimateRequest,
  ): Promise<PromptVersionCostEstimate> {
    return this.service.estimateVersionCost(request.user, id, body);
  }

  @Post(':id/adaptations')
  @LlmRateLimit(LlmRatePolicies.ADAPT)
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
  @LlmRateLimit(LlmRatePolicies.PREVIEW)
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
@UseGuards(JwtAuthGuard, RolesGuard, LlmRateLimitGuard)
@Roles('user', 'admin')
export class PromptJobsController {
  constructor(@Inject(PromptProjectsService) private readonly service: PromptProjectsService) {}

  @Get(':id/preview')
  preview(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ZodValidationPipe(PublicIdSchema)) id: string,
  ): Promise<PromptPreview> {
    return this.service.getPreview(request.user, id);
  }

  @Get(':id')
  get(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ZodValidationPipe(PublicIdSchema)) id: string,
  ): Promise<PromptGenerationJob> {
    return this.service.getJob(request.user, id);
  }

  @Post(':id/cancel')
  @LlmRateLimit(LlmRatePolicies.CANCEL)
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
