import { describe, expect, it } from 'vitest';
import { AiConnectionSchema } from './ai-connections.js';
import { PromptPreviewSchema, PromptWizardInputSchema } from './prompt-projects.js';

describe('LLM public contracts', () => {
  it('rejects unknown wizard keys and oversized instructions', () => {
    expect(() => PromptWizardInputSchema.parse({
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
      freeInstructions: 'x'.repeat(8_001),
      unknown: true,
    })).toThrow();
  });

  it('never accepts a raw provider payload in a public preview', () => {
    expect(() => PromptPreviewSchema.parse({
      id: 'cm1234567890abcdef',
      promptVersionId: 'cm2234567890abcdef',
      status: 'SUCCEEDED',
      content: 'Prévia em linguagem natural.',
      provider: 'OPENAI',
      model: 'configured-model',
      rawResponse: { secret: true },
    })).toThrow();
  });

  it('never returns credential material', () => {
    expect(AiConnectionSchema.keyof().options).not.toContain('encryptedCredential');
    expect(AiConnectionSchema.keyof().options).not.toContain('accessToken');
  });
});
