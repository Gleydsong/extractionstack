import { createHmac } from 'node:crypto';
import type { CanActivate, ExecutionContext, OnModuleDestroy } from '@nestjs/common';
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Auth0User } from '@extractionstack/shared';
import Redis from 'ioredis';

export type LlmRatePolicy = Readonly<{
  operation: string;
  userLimit: number;
  ipLimit: number;
  ttlMs: number;
  costly: true;
}>;
export type LlmRateKeys = Readonly<{ user: string; ip: string }>;
export interface LlmRateLimitStore {
  consume(
    keys: LlmRateKeys,
    policy: LlmRatePolicy,
  ): Promise<{ allowed: boolean; remaining: number }>;
}

export const LLM_RATE_LIMIT_METADATA = 'extractionstack:llm-rate-policy';
const policy = (operation: string, userLimit: number, ipLimit = userLimit * 4): LlmRatePolicy =>
  Object.freeze({ operation, userLimit, ipLimit, ttlMs: 60_000, costly: true });
export const LlmRatePolicies = Object.freeze({
  PROJECT_CREATE: policy('project_create', 10),
  EDIT: policy('edit', 10),
  GENERATE: policy('generate', 3),
  ADAPT: policy('adapt', 3),
  ESTIMATE: policy('estimate', 10),
  PREVIEW: policy('preview', 5),
  CONNECTION_API_KEY: policy('connection_api_key', 3),
  OAUTH_START: policy('oauth_start', 5),
  OAUTH_CALLBACK: policy('oauth_callback', 10),
  CONNECTION_VALIDATE: policy('connection_validate', 3),
  CONNECTION_REVOKE: policy('connection_revoke', 5),
  CANCEL: policy('cancel', 10),
});
export const LlmRateLimit = (value: LlmRatePolicy) => SetMetadata(LLM_RATE_LIMIT_METADATA, value);

type GuardRequest = Readonly<{ ip?: string; user?: Auth0User }>;

@Injectable()
export class LlmRateLimitGuard implements CanActivate {
  constructor(
    @Inject('LLM_RATE_LIMIT_STORE') private readonly store: LlmRateLimitStore,
    @Inject('LLM_RATE_LIMIT_HMAC_KEY') private readonly hmacKey: string,
    @Inject(Reflector) private readonly reflector: Reflector = new Reflector(),
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const selected = this.reflector.getAllAndOverride<LlmRatePolicy>(LLM_RATE_LIMIT_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!selected) return true;
    const request = context.switchToHttp().getRequest<GuardRequest>();
    const ip = normalizeIp(request.ip);
    const owner = request.user?.sub ?? `anonymous:${ip}`;
    const keys = {
      user: opaqueKey(this.hmacKey, 'user', owner, selected.operation),
      ip: opaqueKey(this.hmacKey, 'ip', ip, selected.operation),
    };
    try {
      const result = await this.store.consume(keys, selected);
      if (!result.allowed) throw rateLimited();
      return true;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'rate limit unavailable',
      });
    }
  }
}

export class RedisLlmRateLimitStore implements LlmRateLimitStore, OnModuleDestroy {
  constructor(private readonly redis: Redis | Pick<Redis, 'eval'>) {}
  async consume(
    keys: LlmRateKeys,
    selected: LlmRatePolicy,
  ): Promise<{ allowed: boolean; remaining: number }> {
    if (this.redis instanceof Redis && this.redis.status === 'wait') await this.redis.connect();
    const result = await this.redis.eval(
      "local u=redis.call('INCR',KEYS[1]); if u==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; local i=redis.call('INCR',KEYS[2]); if i==1 then redis.call('PEXPIRE',KEYS[2],ARGV[1]) end; return {u,i}",
      2,
      keys.user,
      keys.ip,
      String(selected.ttlMs),
    );
    if (!Array.isArray(result) || result.length !== 2)
      throw new Error('RATE_LIMIT_RESPONSE_INVALID');
    const userCount = Number(result[0]);
    const ipCount = Number(result[1]);
    if (![userCount, ipCount].every((value) => Number.isSafeInteger(value) && value >= 1))
      throw new Error('RATE_LIMIT_RESPONSE_INVALID');
    return {
      allowed: userCount <= selected.userLimit && ipCount <= selected.ipLimit,
      remaining: Math.max(0, Math.min(selected.userLimit - userCount, selected.ipLimit - ipCount)),
    };
  }
  async onModuleDestroy(): Promise<void> {
    const redis = this.redis;
    if (redis instanceof Redis && redis.status !== 'end')
      await redis.quit().catch(() => redis.disconnect());
  }
}

function opaqueKey(
  secret: string,
  kind: 'user' | 'ip',
  principal: string,
  operation: string,
): string {
  return `llm-rate:v2:${kind}:${createHmac('sha256', secret).update(`${kind}\0${principal}\0${operation}`).digest('hex')}`;
}
function normalizeIp(value: string | undefined): string {
  const normalized = value?.trim().slice(0, 64);
  return normalized && /^[0-9a-f:.]+$/i.test(normalized) ? normalized : 'unknown';
}
function rateLimited(): HttpException {
  return new HttpException(
    { code: 'RATE_LIMITED', message: 'rate limit exceeded' },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}
