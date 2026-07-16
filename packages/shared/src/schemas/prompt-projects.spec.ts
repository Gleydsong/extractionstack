import { describe, expect, it } from 'vitest';
import {
  AiConnectionSchema,
  ProviderAuthorizationSchema,
  PublicIsoDateTimeSchema,
} from './ai-connections.js';
import {
  PromptGenerationJobSchema,
  PromptPreviewSchema,
  PromptWizardInputSchema,
} from './prompt-projects.js';

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
  it('rejects unknown wizard keys', () => {
    expect(() => PromptWizardInputSchema.parse({ ...wizardFixture, unknown: true })).toThrow();
  });

  it('rejects oversized wizard instructions', () => {
    expect(() => PromptWizardInputSchema.parse({
      ...wizardFixture,
      freeInstructions: 'x'.repeat(8_001),
    })).toThrow();
  });

  it('never accepts a raw provider payload in a public preview', () => {
    expect(PromptPreviewSchema.parse(previewFixture)).toEqual(previewFixture);
    expect(() => PromptPreviewSchema.parse({
      ...previewFixture,
      rawResponse: { secret: true },
    })).toThrow();
  });

  it('enforces the provider credential-mode authorization matrix', () => {
    expect(ProviderAuthorizationSchema.safeParse({
      provider: 'FAKE',
      credentialMode: 'PLATFORM_CREDITS',
    }).success).toBe(true);
    expect(ProviderAuthorizationSchema.safeParse({
      provider: 'OPENAI',
      credentialMode: 'API_KEY',
    }).success).toBe(true);
    expect(ProviderAuthorizationSchema.safeParse({
      provider: 'GEMINI',
      credentialMode: 'OAUTH',
    }).success).toBe(true);
    expect(ProviderAuthorizationSchema.safeParse({
      provider: 'OPENAI',
      credentialMode: 'OAUTH',
    }).success).toBe(false);
    expect(ProviderAuthorizationSchema.safeParse({
      provider: 'FAKE',
      credentialMode: 'API_KEY',
    }).success).toBe(false);
  });

  it('applies provider authorization to connections and generation jobs', () => {
    expect(AiConnectionSchema.safeParse(aiConnectionFixture).success).toBe(true);
    expect(AiConnectionSchema.safeParse({
      ...aiConnectionFixture,
      credentialMode: 'OAUTH',
    }).success).toBe(false);
    expect(PromptGenerationJobSchema.safeParse(promptJobFixture).success).toBe(true);
    expect(PromptGenerationJobSchema.safeParse({
      ...promptJobFixture,
      credentialMode: 'OAUTH',
    }).success).toBe(false);
  });

  it('bounds ISO datetimes and reuses the bound in public responses', () => {
    const oversizedIsoDateTime = `2026-07-16T20:00:00.${'1'.repeat(30)}Z`;

    expect(PublicIsoDateTimeSchema.safeParse(now).success).toBe(true);
    expect(PublicIsoDateTimeSchema.safeParse(oversizedIsoDateTime).success).toBe(false);
    expect(AiConnectionSchema.safeParse({
      ...aiConnectionFixture,
      createdAt: oversizedIsoDateTime,
    }).success).toBe(false);
    expect(PromptPreviewSchema.safeParse({
      ...previewFixture,
      createdAt: oversizedIsoDateTime,
    }).success).toBe(false);
  });

  it('never returns credential material', () => {
    const publicFields = Object.keys(AiConnectionSchema.parse(aiConnectionFixture));

    expect(publicFields).not.toContain('encryptedCredential');
    expect(publicFields).not.toContain('accessToken');
  });
});
