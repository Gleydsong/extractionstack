import { Module } from '@nestjs/common';
import {
  CredentialResolver,
  GeminiProviderAdapter,
  OpenAiProviderAdapter,
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
      provide: CredentialResolver,
      useFactory: (
        registry: ProviderRegistry,
        repository: LlmJobRepository,
        prisma: PrismaClient,
      ) => {
        const env = loadRuntimeEnv(process.env);
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
          credits: repository,
        }),
      inject: [LlmJobRepository, CredentialResolver, PROVIDERS],
    },
    {
      provide: LlmQueueWorkerService,
      useFactory: (processor: LlmJobProcessor) => {
        const env = loadRuntimeEnv(process.env);
        return new LlmQueueWorkerService(processor, {
          redisUrl: env.REDIS_URL,
          concurrency: env.WORKER_CONCURRENCY,
        });
      },
      inject: [LlmJobProcessor],
    },
  ],
})
export class LlmWorkerModule {}

function createWorkerProviderRegistry(envInput: NodeJS.ProcessEnv): ProviderRegistry {
  const env = loadRuntimeEnv(envInput);
  return new ProviderRegistry([openAiCapabilities(env), geminiCapabilities(env)]);
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
    enabled: true,
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
    enabled: true,
    circuitBreakerOpen: false,
  });
}
function ensureSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
