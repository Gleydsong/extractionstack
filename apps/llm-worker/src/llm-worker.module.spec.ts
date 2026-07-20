import { describe, expect, it } from 'vitest';
import { createPricingCatalog } from './llm-worker.module';

const rate = (provider: 'OPENAI' | 'GEMINI', model: string) => ({
  provider,
  model,
  inputMicrosPerMillionTokens: '1000000',
  cachedInputMicrosPerMillionTokens: '500000',
  outputMicrosPerMillionTokens: '2000000',
  reasoningMicrosPerMillionTokens: '3000000',
  requireCachedTokens: false,
  requireReasoningTokens: false,
});

describe('LLM worker pricing startup', () => {
  it('rejects an allowlisted platform model missing from the pricing catalog', () => {
    expect(() =>
      createPricingCatalog({
        LLM_PRICING_VERSION: 'test-v1',
        LLM_PRICING_CATALOG_JSON: JSON.stringify([rate('OPENAI', 'gpt-test')]),
        LLM_PROMPT_GENERATION_ENABLED: 'true',
        LLM_PROVIDER_MODE: 'live',
        LLM_OPENAI_MODEL_ALLOWLIST: 'gpt-test',
        LLM_GEMINI_MODEL_ALLOWLIST: 'gemini-test',
      }),
    ).toThrow('LLM_PRICING_CATALOG_INCOMPLETE');
  });

  it('accepts exact coverage for all allowlisted platform models', () => {
    const catalog = createPricingCatalog({
      LLM_PRICING_VERSION: 'test-v1',
      LLM_PRICING_CATALOG_JSON: JSON.stringify([
        rate('OPENAI', 'gpt-test'),
        rate('GEMINI', 'gemini-test'),
      ]),
      LLM_PROMPT_GENERATION_ENABLED: 'true',
      LLM_PROVIDER_MODE: 'live',
      LLM_OPENAI_MODEL_ALLOWLIST: 'gpt-test',
      LLM_GEMINI_MODEL_ALLOWLIST: 'gemini-test',
    });
    expect(catalog.has('OPENAI', 'gpt-test')).toBe(true);
    expect(catalog.has('GEMINI', 'gemini-test')).toBe(true);
  });
});
