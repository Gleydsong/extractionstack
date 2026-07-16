import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { collectDefaultMetrics, Counter, Registry } from 'prom-client';
import { loadRuntimeEnv } from '../common/runtime-env.js';

export interface ReadinessResult {
  status: 'ok' | 'unavailable';
  checks: { database: boolean; redis: boolean };
}

@Injectable()
export class OperationsService implements OnModuleDestroy {
  private readonly registry = new Registry();
  private readonly redis: Redis;
  private readonly readinessFailures: Counter;

  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {
    const env = loadRuntimeEnv(process.env);
    this.redis = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 1_000,
    });
    this.redis.on('error', () => undefined);
    collectDefaultMetrics({ register: this.registry, prefix: 'extractionstack_' });
    this.readinessFailures = new Counter({
      name: 'extractionstack_readiness_failures_total',
      help: 'Number of failed readiness dependency checks',
      labelNames: ['dependency'] as const,
      registers: [this.registry],
    });
  }

  async readiness(): Promise<ReadinessResult> {
    const [database, redis] = await Promise.all([
      this.prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
      this.pingRedis(),
    ]);
    if (!database) this.readinessFailures.inc({ dependency: 'database' });
    if (!redis) this.readinessFailures.inc({ dependency: 'redis' });
    return { status: database && redis ? 'ok' : 'unavailable', checks: { database, redis } };
  }

  metrics(): Promise<string> {
    return this.registry.metrics();
  }

  contentType(): string {
    return this.registry.contentType;
  }

  async onModuleDestroy(): Promise<void> {
    this.registry.clear();
    if (this.redis.status !== 'end') await this.redis.quit().catch(() => this.redis.disconnect());
  }

  private async pingRedis(): Promise<boolean> {
    try {
      if (this.redis.status === 'wait') await this.redis.connect();
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
}
