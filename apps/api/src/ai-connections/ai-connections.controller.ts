import {
  Body,
  BadRequestException,
  Controller,
  Delete,
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
  PublicIdSchema,
  type AiConnection,
  type Auth0User,
} from '@extractionstack/shared';
import { z } from 'zod';
import { ProviderRegistry, type PublicProviderCapabilities } from '@extractionstack/llm-core';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AiConnectionsService } from './ai-connections.service.js';

const ApiKeyCommandSchema = z.object({
  provider: z.enum(['OPENAI', 'GEMINI']),
  displayLabel: z.string().trim().min(1).max(120),
  apiKey: z.string().min(8).max(16_384),
}).strict();
type ApiKeyCommand = z.infer<typeof ApiKeyCommandSchema>;

const OAuthProviderSchema = z.literal('GEMINI');
const StartOAuthSchema = z.object({ redirectUri: z.string().url().max(2_048) }).strict();
const OAuthStateSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const AuthorizationCodeSchema = z.string().min(1).max(4_096);

interface AuthenticatedRequest {
  user: Auth0User;
}

@Controller('api/ai/connections')
export class AiConnectionsController {
  constructor(@Inject(AiConnectionsService) private readonly service: AiConnectionsService) {}

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user', 'admin')
  list(@Req() request: AuthenticatedRequest): Promise<AiConnection[]> {
    return this.service.list(request.user);
  }

  @Post('api-key')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user', 'admin')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  addApiKey(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(ApiKeyCommandSchema)) command: ApiKeyCommand,
    @Headers('idempotency-key') rawIdempotencyKey: string | undefined,
  ): Promise<AiConnection> {
    const idempotencyKey = requireIdempotencyKey(rawIdempotencyKey);
    return this.service.addApiKey(request.user, command, idempotencyKey);
  }

  @Post(':provider/oauth/start')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user', 'admin')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  startOAuth(
    @Req() request: AuthenticatedRequest,
    @Param('provider', new ZodValidationPipe(OAuthProviderSchema)) provider: 'GEMINI',
    @Body(new ZodValidationPipe(StartOAuthSchema)) body: { redirectUri: string },
    @Headers('idempotency-key') rawIdempotencyKey: string | undefined,
  ): Promise<{ state: string; authorizationUrl: string }> {
    const idempotencyKey = requireIdempotencyKey(rawIdempotencyKey);
    return this.service.startOAuth(request.user, provider, body.redirectUri, idempotencyKey);
  }

  @Get(':provider/oauth/callback')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  finishOAuth(
    @Param('provider', new ZodValidationPipe(OAuthProviderSchema)) provider: 'GEMINI',
    @Query('state', new ZodValidationPipe(OAuthStateSchema)) state: string,
    @Query('code', new ZodValidationPipe(AuthorizationCodeSchema)) code: string,
  ): Promise<AiConnection> {
    return this.service.finishOAuth(provider, state, code);
  }

  @Post(':id/validate')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user', 'admin')
  @HttpCode(200)
  validate(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ZodValidationPipe(PublicIdSchema)) id: string,
    @Headers('idempotency-key') rawIdempotencyKey: string | undefined,
  ): Promise<AiConnection> {
    const idempotencyKey = requireIdempotencyKey(rawIdempotencyKey);
    return this.service.validate(request.user, id, idempotencyKey);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user', 'admin')
  remove(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ZodValidationPipe(PublicIdSchema)) id: string,
    @Headers('idempotency-key') rawIdempotencyKey: string | undefined,
  ): Promise<AiConnection> {
    const idempotencyKey = requireIdempotencyKey(rawIdempotencyKey);
    return this.service.remove(request.user, id, idempotencyKey);
  }
}

@Controller('api/ai/providers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('user', 'admin')
export class AiProvidersController {
  constructor(@Inject(ProviderRegistry) private readonly registry: ProviderRegistry) {}

  @Get()
  list(): readonly PublicProviderCapabilities[] {
    return this.registry.listPublic();
  }
}

function requireIdempotencyKey(value: string | undefined): string {
  const parsed = IdempotencyKeySchema.safeParse(value);
  if (!parsed.success) {
    throw new BadRequestException({ code: 'VALIDATION', message: 'invalid idempotency key' });
  }
  return parsed.data;
}
