import { Module } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import {
  CredentialResolver,
  FakeProviderAdapter,
  GeminiProviderAdapter,
  OpenAiProviderAdapter,
  PricingCatalog,
  PromptComposer,
  PromptSafetyService,
  ProviderFailure,
  ProviderRegistry,
  ReportNarrativeAssembler,
  type LlmProviderAdapter,
  type ProviderCapabilities,
} from '@extractionstack/llm-core';
import type { LlmProvider } from '@extractionstack/shared';
import { PrismaClient } from '@prisma/client';
import { loadRuntimeEnv } from '../../api/src/common/runtime-env.js';
import { PrismaModule } from '../../api/src/prisma/prisma.module.js';
import { CredentialVault } from '../../api/src/ai-connections/credential-vault.js';
import { fromPrismaEnvelope } from '../../api/src/ai-connections/ai-connections.repository.js';
import { LlmJobProcessor } from './llm-job.processor.js';
import { LlmJobRepository } from './llm-job.repository.js';
import { LlmQueueWorkerService } from './llm-queue-worker.service.js';
import { GeminiOAuthRefreshService } from './gemini-oauth-refresh.service.js';
import { LlmReconciliationSweeperService } from './llm-reconciliation-sweeper.service.js';
import { LlmRecoveryQueueService } from './llm-recovery-queue.service.js';
import { LlmWorkerOperationsService } from './llm-worker-operations.service.js';
import { LLM_QUEUE_NAME } from './llm-worker.types.js';

const PROVIDERS = Symbol('LLM_PROVIDER_ADAPTERS');

@Module({
  imports: [PrismaModule],
  providers: [
    {
      provide: LlmJobRepository,
      useFactory: (prisma: PrismaClient) => new LlmJobRepository(prisma),
      inject: [PrismaClient],
    },
    {
      provide: ProviderRegistry,
      useFactory: () => createWorkerProviderRegistry(process.env),
    },
    {
      provide: PROVIDERS,
      useFactory: (registry: ProviderRegistry) => createAdapters(registry, process.env),
      inject: [ProviderRegistry],
    },
    {
      provide: PricingCatalog,
      useFactory: () => createPricingCatalog(process.env),
    },
    {
      provide: CredentialResolver,
      useFactory: (
        registry: ProviderRegistry,
        repository: LlmJobRepository,
        prisma: PrismaClient,
      ) => {
        const env = loadRuntimeEnv(process.env);
        if (env.LLM_PROVIDER_MODE === 'fake') {
          return {
            resolve: async (request: {
              provider: LlmProvider;
              mode: string;
              connectionId: string | null;
            }) => {
              if (
                request.provider !== 'FAKE' ||
                request.mode !== 'PLATFORM_CREDITS' ||
                request.connectionId !== null
              ) {
                throw new ProviderFailure('AUTHORIZATION_FAILED');
              }
              return Object.freeze({
                mode: 'PLATFORM_CREDITS' as const,
                value: 'local-provider-double',
              });
            },
          } as unknown as CredentialResolver;
        }
        if (!env.LLM_CREDENTIAL_MASTER_KEY) throw new Error('LLM_CREDENTIAL_MASTER_KEY_REQUIRED');
        const vault = new CredentialVault(
          env.LLM_CREDENTIAL_MASTER_KEY,
          env.LLM_CREDENTIAL_KEY_VERSION,
        );
        const oauthRefresh = new GeminiOAuthRefreshService(prisma, vault, process.env);
        return new CredentialResolver(
          registry,
          repository,
          {
            decrypt: async (ownerId, provider, value) => {
              if (!value || typeof value !== 'object')
                throw new ProviderFailure('AUTHENTICATION_FAILED');
              try {
                return await vault.decrypt(ownerId, provider, fromPrismaEnvelope(value as never));
              } catch {
                throw new ProviderFailure('AUTHENTICATION_FAILED');
              }
            },
          },
          {
            resolve: async (provider) => {
              const variable =
                provider === 'OPENAI'
                  ? 'LLM_PLATFORM_OPENAI_API_KEY'
                  : 'LLM_PLATFORM_GEMINI_API_KEY';
              const secret = process.env[variable]?.trim();
              if (!secret || secret.length > 16_384)
                throw new ProviderFailure('AUTHENTICATION_FAILED');
              return secret;
            },
          },
          oauthRefresh,
        );
      },
      inject: [ProviderRegistry, LlmJobRepository, PrismaClient],
    },
    {
      provide: LlmJobProcessor,
      useFactory: (
        repository: LlmJobRepository,
        credentials: CredentialResolver,
        providers: Map<LlmProvider, LlmProviderAdapter>,
        pricing: PricingCatalog,
        operations: LlmWorkerOperationsService,
      ) =>
        new LlmJobProcessor({
          store: repository,
          assembler: new ReportNarrativeAssembler(),
          safety: new PromptSafetyService(),
          composer: new PromptComposer(),
          credentials,
          providers: {
            get: (provider) => {
              const adapter = providers.get(provider);
              if (!adapter) throw new ProviderFailure('PROVIDER_NOT_CONFIGURED');
              return adapter;
            },
          },
          pricing,
          operations,
        }),
      inject: [
        LlmJobRepository,
        CredentialResolver,
        PROVIDERS,
        PricingCatalog,
        LlmWorkerOperationsService,
      ],
    },
    {
      provide: LlmQueueWorkerService,
      useFactory: (processor: LlmJobProcessor, operations: LlmWorkerOperationsService) => {
        const env = loadRuntimeEnv(process.env);
        return new LlmQueueWorkerService(
          processor,
          {
            redisUrl: env.REDIS_URL,
            concurrency: env.WORKER_CONCURRENCY,
          },
          operations,
        );
      },
      inject: [LlmJobProcessor, LlmWorkerOperationsService],
    },
    {
      provide: LlmRecoveryQueueService,
      useFactory: () => new LlmRecoveryQueueService(loadRuntimeEnv(process.env).REDIS_URL),
    },
    {
      provide: LlmReconciliationSweeperService,
      useFactory: (repository: LlmJobRepository, queue: LlmRecoveryQueueService) =>
        new LlmReconciliationSweeperService(repository, queue),
      inject: [LlmJobRepository, LlmRecoveryQueueService],
    },
    {
      provide: LlmWorkerOperationsService,
      useFactory: (prisma: PrismaClient, pricing: PricingCatalog) => {
        const env = loadRuntimeEnv(process.env);
        const redisUrl = new URL(env.REDIS_URL);
        const connection = new Redis(env.REDIS_URL, {
          lazyConnect: true,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          connectTimeout: 1_000,
        });
        connection.on('error', () => undefined);
        const queue = new Queue(LLM_QUEUE_NAME, {
          connection: {
            host: redisUrl.hostname,
            port: Number(redisUrl.port || 6379),
            username: redisUrl.username || undefined,
            password: redisUrl.password || undefined,
            db: redisUrl.pathname.length > 1 ? Number(redisUrl.pathname.slice(1)) : 0,
            ...(redisUrl.protocol === 'rediss:' ? { tls: {} } : {}),
          },
        });
        return new LlmWorkerOperationsService({
          database: async () => Boolean(await prisma.$queryRaw`SELECT 1`),
          redis: async () => {
            if (connection.status === 'wait') await connection.connect();
            return (await connection.ping()) === 'PONG';
          },
          queue: async () => {
            await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
            return true;
          },
          publishHeartbeat: async (timestamp) => {
            if (connection.status === 'wait') await connection.connect();
            await connection.set('llm-worker:v1:heartbeat', String(timestamp), 'PX', 15_000);
          },
          publishSnapshot: async (metrics) => {
            if (connection.status === 'wait') await connection.connect();
            await connection.set('llm-worker:v1:metrics', metrics, 'PX', 15_000);
          },
          configuration: () => Boolean(pricing),
          close: async () => {
            await queue.close();
            if (connection.status !== 'end')
              await connection.quit().catch(() => connection.disconnect());
          },
        });
      },
      inject: [PrismaClient, PricingCatalog],
    },
  ],
})
export class LlmWorkerModule {}

function createWorkerProviderRegistry(envInput: NodeJS.ProcessEnv): ProviderRegistry {
  const env = loadRuntimeEnv(envInput);
  if (env.LLM_PROVIDER_MODE === 'fake') {
    return new ProviderRegistry([fakeCapabilities(env)], { allowTestProvider: true });
  }
  return new ProviderRegistry([openAiCapabilities(env), geminiCapabilities(env)]);
}

export function createPricingCatalog(env: NodeJS.ProcessEnv): PricingCatalog {
  const raw = env.LLM_PRICING_CATALOG_JSON?.trim() ?? '[]';
  if (raw.length > 65_536) throw new Error('LLM_PRICING_CATALOG_INVALID');
  let entries: unknown;
  try {
    entries = JSON.parse(raw);
  } catch {
    throw new Error('LLM_PRICING_CATALOG_INVALID');
  }
  if (!Array.isArray(entries)) throw new Error('LLM_PRICING_CATALOG_INVALID');
  const catalog = new PricingCatalog(env.LLM_PRICING_VERSION?.trim() || 'unconfigured-v1', entries);
  const runtime = loadRuntimeEnv(env);
  const required = !runtime.LLM_PROMPT_GENERATION_ENABLED
    ? ([] as const)
    : runtime.LLM_PROVIDER_MODE === 'fake'
      ? ([['FAKE', ['fake-deterministic-v1']]] as const)
      : ([
          ['OPENAI', runtime.LLM_OPENAI_MODEL_ALLOWLIST],
          ['GEMINI', runtime.LLM_GEMINI_MODEL_ALLOWLIST],
        ] as const);
  for (const [provider, models] of required) {
    if (models.some((model) => !catalog.has(provider, model)))
      throw new Error('LLM_PRICING_CATALOG_INCOMPLETE');
  }
  return catalog;
}

function createAdapters(
  registry: ProviderRegistry,
  envInput: NodeJS.ProcessEnv,
): Map<LlmProvider, LlmProviderAdapter> {
  const env = loadRuntimeEnv(envInput);
  const common = {
    fetch: globalThis.fetch,
    timeoutMs: env.LLM_TIMEOUT_MS,
    maxOutputCharacters: 100_000,
  };
  if (env.LLM_PROVIDER_MODE === 'fake') {
    return new Map<LlmProvider, LlmProviderAdapter>([
      [
        'FAKE',
        new FakeProviderAdapter({
          allowTestProvider: true,
          capabilities: registry.get('FAKE'),
          content:
            'Prompt de teste determinístico. Defina o objetivo, preserve as evidências e produza uma saída clara em linguagem natural.',
        }),
      ],
    ]);
  }
  return new Map<LlmProvider, LlmProviderAdapter>([
    [
      'OPENAI',
      new OpenAiProviderAdapter({
        ...common,
        baseUrl: new URL(ensureSlash(env.LLM_OPENAI_BASE_URL)),
        capabilities: registry.get('OPENAI'),
      }),
    ],
    [
      'GEMINI',
      new GeminiProviderAdapter({
        ...common,
        baseUrl: new URL(ensureSlash(env.LLM_GEMINI_BASE_URL)),
        capabilities: { ...registry.get('GEMINI'), supportsCredentialRefresh: false },
      }),
    ],
  ]);
}

function openAiCapabilities(env: ReturnType<typeof loadRuntimeEnv>): ProviderCapabilities {
  return Object.freeze({
    provider: 'OPENAI',
    credentialModes: Object.freeze(['API_KEY', 'PLATFORM_CREDITS'] as const),
    models: env.LLM_OPENAI_MODEL_ALLOWLIST,
    contextWindowTokens: env.LLM_MAX_INPUT_TOKENS,
    maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
    supportsStructuredOutput: true,
    supportsCancellation: false,
    supportsCredentialRefresh: false,
    oauthScopes: Object.freeze([]),
    previewEligible: true,
    pricingMetadataVersion: 'configured-2026-07-17',
    enabled: env.LLM_PROMPT_GENERATION_ENABLED && env.LLM_PROVIDER_OPENAI_ENABLED,
    circuitBreakerOpen: false,
  });
}
function fakeCapabilities(env: ReturnType<typeof loadRuntimeEnv>): ProviderCapabilities {
  return Object.freeze({
    provider: 'FAKE',
    credentialModes: Object.freeze(['PLATFORM_CREDITS'] as const),
    models: Object.freeze(['fake-deterministic-v1']),
    contextWindowTokens: env.LLM_MAX_INPUT_TOKENS,
    maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
    supportsStructuredOutput: false,
    supportsCancellation: false,
    supportsCredentialRefresh: false,
    oauthScopes: Object.freeze([]),
    previewEligible: true,
    pricingMetadataVersion: env.LLM_PRICING_VERSION,
    enabled: env.LLM_PROMPT_GENERATION_ENABLED,
    circuitBreakerOpen: false,
  });
}
function geminiCapabilities(env: ReturnType<typeof loadRuntimeEnv>): ProviderCapabilities {
  return Object.freeze({
    provider: 'GEMINI',
    credentialModes: Object.freeze(['OAUTH', 'API_KEY', 'PLATFORM_CREDITS'] as const),
    models: env.LLM_GEMINI_MODEL_ALLOWLIST,
    contextWindowTokens: env.LLM_MAX_INPUT_TOKENS,
    maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
    supportsStructuredOutput: true,
    supportsCancellation: false,
    supportsCredentialRefresh: true,
    oauthScopes: Object.freeze(['https://www.googleapis.com/auth/cloud-platform']),
    previewEligible: true,
    pricingMetadataVersion: 'configured-2026-07-17',
    enabled: env.LLM_PROMPT_GENERATION_ENABLED && env.LLM_PROVIDER_GEMINI_ENABLED,
    circuitBreakerOpen: false,
  });
}
function ensureSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
