import { describe, expect, it } from 'vitest';
import { PricingCatalog, PricingFailure } from './pricing-catalog';

const catalog = () =>
  new PricingCatalog('pricing-2026-07', [
    {
      provider: 'OPENAI',
      model: 'gpt-test',
      inputMicrosPerMillionTokens: '1000000',
      cachedInputMicrosPerMillionTokens: '500000',
      outputMicrosPerMillionTokens: '2000000',
      reasoningMicrosPerMillionTokens: '3000000',
      requireCachedTokens: true,
      requireReasoningTokens: true,
    },
  ]);

describe('PricingCatalog', () => {
  it('prices input, cached, output and reasoning with bigint-safe ceiling', () => {
    expect(
      catalog().price('OPENAI', 'gpt-test', {
        inputTokens: 3,
        cachedInputTokens: 1,
        outputTokens: 2,
        reasoningTokens: 1,
        totalTokens: 5,
        estimatedCostMicros: null,
      }),
    ).toEqual({ pricingVersion: 'pricing-2026-07', amountMicros: 8n, amountMinor: 1n });
  });

  it('rejects missing price instead of confirming zero', () => {
    expect(() =>
      catalog().price('GEMINI', 'unknown', {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        estimatedCostMicros: null,
      }),
    ).toThrowError(PricingFailure);
  });

  it('rejects usage without required cached or reasoning details', () => {
    expect(() =>
      catalog().price('OPENAI', 'gpt-test', {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        estimatedCostMicros: null,
      }),
    ).toThrowError('PRICING_USAGE_INSUFFICIENT');
  });

  it('quotes a conservative bigint-safe ceiling using the most expensive token classes', () => {
    expect(catalog().quoteMaximum('OPENAI', 'gpt-test', 3, 2)).toEqual({
      pricingVersion: 'pricing-2026-07',
      amountMicros: 9n,
      amountMinor: 1n,
    });
  });

  it('rejects unsafe or overflowing token bounds', () => {
    expect(() => catalog().quoteMaximum('OPENAI', 'gpt-test', Number.MAX_SAFE_INTEGER, 1)).toThrow(
      'PRICING_USAGE_INSUFFICIENT',
    );
    expect(() => catalog().quoteMaximum('OPENAI', 'gpt-test', -1, 1)).toThrow(
      'PRICING_USAGE_INSUFFICIENT',
    );
  });

  it('reports model coverage without throwing', () => {
    expect(catalog().has('OPENAI', 'gpt-test')).toBe(true);
    expect(catalog().has('GEMINI', 'missing')).toBe(false);
  });

  it('supports deterministic FAKE-provider pricing for isolated end-to-end tests', () => {
    const fake = new PricingCatalog('fake-test-v1', [
      {
        provider: 'FAKE',
        model: 'fake-deterministic-v1',
        inputMicrosPerMillionTokens: '1',
        cachedInputMicrosPerMillionTokens: '1',
        outputMicrosPerMillionTokens: '1',
        reasoningMicrosPerMillionTokens: '1',
        requireCachedTokens: false,
        requireReasoningTokens: false,
      },
    ]);

    expect(fake.has('FAKE', 'fake-deterministic-v1')).toBe(true);
    expect(
      fake.price('FAKE', 'fake-deterministic-v1', {
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        estimatedCostMicros: 0,
      }),
    ).toEqual({ pricingVersion: 'fake-test-v1', amountMicros: 1n, amountMinor: 1n });
  });
});
