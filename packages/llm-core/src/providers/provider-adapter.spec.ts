import { describe, expect, it } from 'vitest';
import {
  ConnectionValidationSchema,
  GenerationInputSchema,
  NormalizedGenerationSchema,
  NormalizedPreviewSchema,
  NormalizedUsageSchema,
  PreviewInputSchema,
  ProviderRequestIdSchema,
  UsageEstimateSchema,
  ValidateConnectionInputSchema,
  parseConnectionValidation,
  parseGenerationInput,
  parseNormalizedGeneration,
  parseNormalizedPreview,
  parseNormalizedUsage,
  parsePreviewInput,
  parseUsageEstimate,
  parseValidateConnectionInput,
} from './provider-adapter';

const now = '2026-07-16T20:00:00.000Z';

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

const generationFixture = {
  provider: 'OPENAI',
  model: 'configured-test-model',
  credential: { mode: 'API_KEY', value: 'test-secret' },
  wizardInput: wizardFixture,
  sourcePrompt: null,
  layers: [{ kind: 'task', content: 'Produza um prompt claro e seguro.' }],
  maxOutputTokens: 4_096,
} as const;

const previewFixture = {
  id: 'cm1234567890abcdef',
  promptVersionId: 'cm2234567890abcdef',
  status: 'SUCCEEDED',
  content: 'Prévia em linguagem natural.',
  summary: 'Resumo da prévia.',
  provider: 'OPENAI',
  model: 'configured-test-model',
  finishReason: 'completed',
  latencyMs: 250,
  createdAt: now,
  completedAt: now,
} as const;

const usageFixture = {
  inputTokens: 20,
  outputTokens: 10,
  totalTokens: 30,
  estimatedCostMicros: 150,
} as const;

const normalizedGenerationFixture = {
  content: 'Prompt universal de teste.',
  finishReason: 'complete',
  providerRequestId: 'request_123.safe',
  usage: usageFixture,
} as const;

describe('provider adapter runtime boundaries', () => {
  it('parses only approved provider credential combinations', () => {
    expect(
      parseValidateConnectionInput({
        provider: 'OPENAI',
        credential: { mode: 'API_KEY', value: 'test-secret' },
      }),
    ).toMatchObject({ provider: 'OPENAI' });

    expect(() =>
      parseValidateConnectionInput({
        provider: 'OPENAI',
        credential: { mode: 'OAUTH', value: 'test-secret' },
      }),
    ).toThrow();
    expect(
      ValidateConnectionInputSchema.safeParse({
        provider: 'FAKE',
        credential: { mode: 'API_KEY', value: 'test-secret' },
      }).success,
    ).toBe(false);
  });

  it('strictly parses generation and preview inputs', () => {
    expect(parseGenerationInput(generationFixture)).toEqual(generationFixture);
    expect(
      parsePreviewInput({ generation: generationFixture, preview: previewFixture }),
    ).toMatchObject({ preview: previewFixture });

    expect(
      GenerationInputSchema.safeParse({ ...generationFixture, rawProviderBody: 'unsafe' }).success,
    ).toBe(false);
    expect(
      PreviewInputSchema.safeParse({
        generation: generationFixture,
        preview: previewFixture,
        internalEndpoint: 'https://internal.test',
      }).success,
    ).toBe(false);
  });

  it('enforces non-negative integer usage with a consistent total', () => {
    expect(parseNormalizedUsage(usageFixture)).toEqual(usageFixture);
    expect(NormalizedUsageSchema.safeParse({ ...usageFixture, inputTokens: -1 }).success).toBe(
      false,
    );
    expect(NormalizedUsageSchema.safeParse({ ...usageFixture, outputTokens: 1.5 }).success).toBe(
      false,
    );
    expect(NormalizedUsageSchema.safeParse({ ...usageFixture, totalTokens: 31 }).success).toBe(
      false,
    );
    expect(
      NormalizedUsageSchema.safeParse({
        ...usageFixture,
        inputTokens: 2_147_483_648,
        totalTokens: 2_147_483_668,
      }).success,
    ).toBe(false);
  });

  it('bounds normalized natural-language generation and request identifiers', () => {
    expect(parseNormalizedGeneration(normalizedGenerationFixture)).toEqual(
      normalizedGenerationFixture,
    );
    expect(
      NormalizedGenerationSchema.safeParse({ ...normalizedGenerationFixture, content: '   ' })
        .success,
    ).toBe(false);
    expect(
      NormalizedGenerationSchema.safeParse({
        ...normalizedGenerationFixture,
        content: 'x'.repeat(100_001),
      }).success,
    ).toBe(false);
    expect(
      NormalizedGenerationSchema.safeParse({
        ...normalizedGenerationFixture,
        finishReason: 'provider-specific-stop',
      }).success,
    ).toBe(false);
    expect(
      NormalizedGenerationSchema.safeParse({
        ...normalizedGenerationFixture,
        providerRequestId: 'unsafe request id',
      }).success,
    ).toBe(false);
    expect(
      NormalizedGenerationSchema.safeParse({
        ...normalizedGenerationFixture,
        providerRequestId: 'x'.repeat(161),
      }).success,
    ).toBe(false);
    expect(
      NormalizedGenerationSchema.safeParse({
        ...normalizedGenerationFixture,
        providerRequestId: null,
      }).success,
    ).toBe(true);
  });

  it('strictly parses bounded normalized previews', () => {
    const normalizedPreview = {
      ...normalizedGenerationFixture,
      content: 'Prévia natural.',
      summary: 'Resumo natural.',
    } as const;

    expect(parseNormalizedPreview(normalizedPreview)).toEqual(normalizedPreview);
    expect(NormalizedPreviewSchema.safeParse({ ...normalizedPreview, summary: '' }).success).toBe(
      false,
    );
    expect(
      NormalizedPreviewSchema.safeParse({ ...normalizedPreview, rawResponse: 'unsafe' }).success,
    ).toBe(false);
  });

  it('exports strict schemas and parser functions for every tested boundary', () => {
    expect(GenerationInputSchema).toBeDefined();
    expect(PreviewInputSchema).toBeDefined();
    expect(NormalizedUsageSchema).toBeDefined();
    expect(NormalizedGenerationSchema).toBeDefined();
    expect(NormalizedPreviewSchema).toBeDefined();
    expect(ProviderRequestIdSchema).toBeDefined();
    expect(parseGenerationInput).toBeTypeOf('function');
    expect(parsePreviewInput).toBeTypeOf('function');
    expect(parseConnectionValidation({ valid: true, expiresAt: null, scopes: [] })).toEqual({
      valid: true,
      expiresAt: null,
      scopes: [],
    });
    expect(
      parseUsageEstimate({
        usage: usageFixture,
        pricingMetadataVersion: 'test-2026-07-16',
      }),
    ).toMatchObject({ usage: usageFixture });
    expect(
      ConnectionValidationSchema.safeParse({
        valid: true,
        expiresAt: null,
        scopes: [],
        accessToken: 'unsafe',
      }).success,
    ).toBe(false);
    expect(
      UsageEstimateSchema.safeParse({
        usage: usageFixture,
        pricingMetadataVersion: 'test-2026-07-16',
        internalPriceTable: true,
      }).success,
    ).toBe(false);
  });
});
