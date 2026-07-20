import { Global, Module } from '@nestjs/common';
import Redis from 'ioredis';
import { loadRuntimeEnv } from './runtime-env.js';
import { LlmRateLimitGuard, RedisLlmRateLimitStore } from './llm-rate-limit.guard.js';

@Global()
@Module({
  providers: [
    {
      provide: 'LLM_RATE_LIMIT_STORE',
      useFactory: () => {
        const redis = new Redis(loadRuntimeEnv(process.env).REDIS_URL, {
          lazyConnect: true,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          connectTimeout: 1_000,
        });
        redis.on('error', () => undefined);
        return new RedisLlmRateLimitStore(redis);
      },
    },
    {
      provide: 'LLM_RATE_LIMIT_HMAC_KEY',
      useFactory: () => loadRuntimeEnv(process.env).LLM_RATE_LIMIT_HMAC_KEY,
    },
    LlmRateLimitGuard,
  ],
  exports: ['LLM_RATE_LIMIT_STORE', 'LLM_RATE_LIMIT_HMAC_KEY', LlmRateLimitGuard],
})
export class LlmRateLimitModule {}
