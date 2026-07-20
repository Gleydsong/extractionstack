import { describe, expect, it } from 'vitest';
import {
  AiConnectionSchema,
  ProviderAuthorizationSchema,
  PublicIsoDateTimeSchema,
} from './ai-connections.js';
import {
  PromptAdaptationRequestSchema,
  PromptCostEstimateRequestSchema,
  PromptCostEstimateSchema,
  PromptGenerationRequestSchema,
  PromptPreviewRequestSchema,
  PromptProjectListQuerySchema,
  PromptGenerationJobSchema,
  PromptPreviewSchema,
  PromptVersionDetailSchema,
  PromptVersionEditRequestSchema,
  PromptVersionListResponseSchema,
  PromptVersionCostEstimateRequestSchema,
  PromptWizardInputSchema,
} from './prompt-projects.js';

describe('prompt project command contracts', () => {
  const execution = {
    provider: 'OPENAI',
    model: 'configured-model',
    credentialMode: 'PLATFORM_CREDITS',
    connectionId: null,
    acceptPlatformCharge: true,
    maximumCostMinor: '100',
  } as const;

  it('accepts only strict bounded execution commands', () => {
    expect(PromptGenerationRequestSchema.parse(execution)).toEqual(execution);
    expect(() =>
      PromptGenerationRequestSchema.parse({ ...execution, rawProviderPayload: {} }),
    ).toThrow();
    expect(() =>
      PromptGenerationRequestSchema.parse({ ...execution, maximumCostMinor: '1.5' }),
    ).toThrow();
    expect(
      PromptGenerationRequestSchema.parse({
        ...execution,
        maximumCostMinor: '1000000000000',
      }).maximumCostMinor,
    ).toBe('1000000000000');
    expect(() =>
      PromptGenerationRequestSchema.parse({
        ...execution,
        maximumCostMinor: '1000000000001',
      }),
    ).toThrow();
  });

  it('exposes a strict server-priced report estimate without pricing internals', () => {
    const request = {
      wizard: wizardFixture,
      provider: 'OPENAI',
      model: 'configured-model',
    } as const;
    const estimate = {
      provider: 'OPENAI',
      model: 'configured-model',
      maximumInputTokens: 2400,
      maximumOutputTokens: 1000,
      maximumCostMinor: '37',
      pricingVersion: 'pricing-2026-07',
      quotedAt: now,
    } as const;
    expect(PromptCostEstimateRequestSchema.parse(request)).toEqual(request);
    expect(PromptCostEstimateSchema.parse(estimate)).toEqual(estimate);
    expect(() => PromptCostEstimateSchema.parse({ ...estimate, rawRates: {} })).toThrow();
    expect(() => PromptCostEstimateSchema.parse({ ...estimate, maximumCostMinor: '-1' })).toThrow();
  });

  it('binds a strict quote request to one immutable source version and operation', () => {
    expect(
      PromptVersionCostEstimateRequestSchema.parse({
        provider: 'OPENAI',
        model: 'configured-model',
        operation: 'ADAPT',
        destination: 'codex',
      }),
    ).toEqual({
      provider: 'OPENAI',
      model: 'configured-model',
      operation: 'ADAPT',
      destination: 'codex',
    });
    expect(() =>
      PromptVersionCostEstimateRequestSchema.parse({
        provider: 'OPENAI',
        model: 'configured-model',
        operation: 'PREVIEW',
        destination: 'codex',
      }),
    ).toThrow();
  });

  it('binds adaptation and preview commands to natural-language public inputs', () => {
    expect(PromptAdaptationRequestSchema.parse({ ...execution, destination: 'codex' })).toEqual({
      ...execution,
      destination: 'codex',
    });
    expect(PromptPreviewRequestSchema.parse(execution)).toEqual(execution);
  });

  it('requires owned connection references for user credentials and forbids them for credits', () => {
    expect(() =>
      PromptGenerationRequestSchema.parse({
        ...execution,
        credentialMode: 'API_KEY',
      }),
    ).toThrow();
    expect(() =>
      PromptGenerationRequestSchema.parse({
        ...execution,
        connectionId: 'cm1234567890abcdef',
      }),
    ).toThrow();
  });

  it('bounds cursor pagination', () => {
    expect(PromptProjectListQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(() => PromptProjectListQuerySchema.parse({ limit: 101 })).toThrow();
  });
});

const wizardFixture = {
  extractionId: 'cm1234567890abcdef',
  category: 'application',
  objective: 'Criar uma aplicação semelhante sem copiar código.',
  audience: 'Desenvolvedores',
  technologies: ['React'],
  exclusions: [],
  requirements: ['Acessível'],
  language: 'pt-BR',
  detail: 'complete',
  destination: 'universal',
  freeInstructions: '',
} as const;

const now = '2026-07-16T20:00:00.000Z';

const previewFixture = {
  id: 'cm1234567890abcdef',
  promptVersionId: 'cm2234567890abcdef',
  status: 'SUCCEEDED',
  content: 'Prévia em linguagem natural.',
  summary: 'Resumo da prévia.',
  provider: 'OPENAI',
  model: 'configured-model',
  finishReason: 'completed',
  latencyMs: 250,
  createdAt: now,
  completedAt: now,
} as const;

const aiConnectionFixture = {
  id: 'cm1234567890abcdef',
  provider: 'OPENAI',
  displayLabel: 'OpenAI principal',
  credentialMode: 'API_KEY',
  state: 'ACTIVE',
  maskedCredential: '****1234',
  scopes: [],
  expiresAt: null,
  validatedAt: now,
  lastUsedAt: null,
  createdAt: now,
  updatedAt: now,
} as const;

const promptJobFixture = {
  id: 'cm1234567890abcdef',
  projectId: 'cm2234567890abcdef',
  operation: 'GENERATE',
  provider: 'OPENAI',
  model: 'configured-model',
  credentialMode: 'API_KEY',
  attempts: 0,
  maxAttempts: 3,
  sourcePromptVersionId: null,
  resultPromptVersionId: null,
  queuedAt: now,
  startedAt: null,
  finishedAt: null,
  createdAt: now,
  updatedAt: now,
  status: 'QUEUED',
  message: 'Geração aguardando processamento.',
} as const;

describe('LLM public contracts', () => {
  it('keeps version reads and manual edits strict, bounded, and natural-language only', () => {
    const version = {
      id: 'cm1234567890abcdef',
      projectId: 'cm2234567890abcdef',
      sequence: 2,
      sourceVersionId: 'cm3234567890abcdef',
      kind: 'UNIVERSAL',
      destination: 'universal',
      content: 'Prompt natural revisado.',
      summary: 'Revisao manual.',
      provider: null,
      model: null,
      createdAt: now,
    } as const;

    expect(PromptVersionDetailSchema.parse(version)).toEqual(version);
    expect(() => PromptVersionDetailSchema.parse({ ...version, rawProviderPayload: {} })).toThrow();
    const { content, ...summary } = version;
    void content;
    expect(
      PromptVersionListResponseSchema.parse({ items: [summary], nextCursor: null }).items[0],
    ).not.toHaveProperty('content');
    expect(PromptVersionEditRequestSchema.parse({ content: 'Conteudo editado.' })).toEqual({
      content: 'Conteudo editado.',
    });
    expect(() => PromptVersionEditRequestSchema.parse({ content: 'x'.repeat(100_001) })).toThrow();
  });

  it('rejects unknown wizard keys', () => {
    expect(() => PromptWizardInputSchema.parse({ ...wizardFixture, unknown: true })).toThrow();
  });

  it('rejects oversized wizard instructions', () => {
    expect(() =>
      PromptWizardInputSchema.parse({
        ...wizardFixture,
        freeInstructions: 'x'.repeat(8_001),
      }),
    ).toThrow();
  });

  it('never accepts a raw provider payload in a public preview', () => {
    expect(PromptPreviewSchema.parse(previewFixture)).toEqual(previewFixture);
    expect(() =>
      PromptPreviewSchema.parse({
        ...previewFixture,
        rawResponse: { secret: true },
      }),
    ).toThrow();
  });

  it('enforces the provider credential-mode authorization matrix', () => {
    expect(
      ProviderAuthorizationSchema.safeParse({
        provider: 'FAKE',
        credentialMode: 'PLATFORM_CREDITS',
      }).success,
    ).toBe(true);
    expect(
      ProviderAuthorizationSchema.safeParse({
        provider: 'OPENAI',
        credentialMode: 'API_KEY',
      }).success,
    ).toBe(true);
    expect(
      ProviderAuthorizationSchema.safeParse({
        provider: 'GEMINI',
        credentialMode: 'OAUTH',
      }).success,
    ).toBe(true);
    expect(
      ProviderAuthorizationSchema.safeParse({
        provider: 'OPENAI',
        credentialMode: 'OAUTH',
      }).success,
    ).toBe(false);
    expect(
      ProviderAuthorizationSchema.safeParse({
        provider: 'FAKE',
        credentialMode: 'API_KEY',
      }).success,
    ).toBe(false);
  });

  it('applies provider authorization to connections and generation jobs', () => {
    expect(AiConnectionSchema.safeParse(aiConnectionFixture).success).toBe(true);
    expect(
      AiConnectionSchema.safeParse({
        ...aiConnectionFixture,
        credentialMode: 'OAUTH',
      }).success,
    ).toBe(false);
    expect(PromptGenerationJobSchema.safeParse(promptJobFixture).success).toBe(true);
    expect(
      PromptGenerationJobSchema.safeParse({
        ...promptJobFixture,
        credentialMode: 'OAUTH',
      }).success,
    ).toBe(false);
  });

  it('bounds ISO datetimes and reuses the bound in public responses', () => {
    const oversizedIsoDateTime = `2026-07-16T20:00:00.${'1'.repeat(30)}Z`;

    expect(PublicIsoDateTimeSchema.safeParse(now).success).toBe(true);
    expect(PublicIsoDateTimeSchema.safeParse(oversizedIsoDateTime).success).toBe(false);
    expect(
      AiConnectionSchema.safeParse({
        ...aiConnectionFixture,
        createdAt: oversizedIsoDateTime,
      }).success,
    ).toBe(false);
    expect(
      PromptPreviewSchema.safeParse({
        ...previewFixture,
        createdAt: oversizedIsoDateTime,
      }).success,
    ).toBe(false);
  });

  it('never returns credential material', () => {
    const publicFields = Object.keys(AiConnectionSchema.parse(aiConnectionFixture));

    expect(publicFields).not.toContain('encryptedCredential');
    expect(publicFields).not.toContain('accessToken');
  });
});
