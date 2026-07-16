import { describe, expect, it } from 'vitest';
import { ProviderFailure } from './provider-errors';
import { ProviderRegistry } from './provider-registry';

const registry = new ProviderRegistry([
  {
    provider: 'FAKE',
    credentialModes: ['PLATFORM_CREDITS'],
    models: ['fake-test-model'],
    contextWindowTokens: 8_192,
    maxOutputTokens: 2_048,
    supportsStructuredOutput: true,
    supportsCancellation: true,
    supportsCredentialRefresh: false,
    oauthScopes: [],
    previewEligible: true,
    pricingMetadataVersion: 'test-2026-07-16',
    enabled: true,
    circuitBreakerOpen: false,
  },
  {
    provider: 'OPENAI',
    credentialModes: ['API_KEY', 'PLATFORM_CREDITS'],
    models: ['openai-test-model'],
    contextWindowTokens: 32_000,
    maxOutputTokens: 4_096,
    supportsStructuredOutput: true,
    supportsCancellation: false,
    supportsCredentialRefresh: false,
    oauthScopes: [],
    previewEligible: true,
    pricingMetadataVersion: 'test-2026-07-16',
    enabled: true,
    circuitBreakerOpen: false,
  },
  {
    provider: 'GEMINI',
    credentialModes: ['OAUTH', 'API_KEY', 'PLATFORM_CREDITS'],
    models: ['gemini-test-model'],
    contextWindowTokens: 32_000,
    maxOutputTokens: 4_096,
    supportsStructuredOutput: true,
    supportsCancellation: false,
    supportsCredentialRefresh: true,
    oauthScopes: ['test.generate'],
    previewEligible: true,
    pricingMetadataVersion: 'test-2026-07-16',
    enabled: true,
    circuitBreakerOpen: false,
  },
]);

describe('ProviderRegistry', () => {
  it('does not advertise OpenAI OAuth', () => {
    expect(registry.get('OPENAI').credentialModes).toEqual(['API_KEY', 'PLATFORM_CREDITS']);
  });

  it('advertises all approved Gemini modes', () => {
    expect(registry.get('GEMINI').credentialModes).toEqual([
      'OAUTH',
      'API_KEY',
      'PLATFORM_CREDITS',
    ]);
  });

  it('accepts only models present in configured capabilities', () => {
    expect(registry.assertModel('OPENAI', 'openai-test-model')).toBe('openai-test-model');
    expect(() => registry.assertModel('OPENAI', 'user-controlled-model')).toThrow(
      'MODEL_UNAVAILABLE',
    );
  });

  it('advertises platform credits without exposing internal details', () => {
    const publicCapabilities = registry.listPublic().find(({ provider }) => provider === 'OPENAI');

    expect(publicCapabilities).toMatchObject({
      credentialModes: ['API_KEY', 'PLATFORM_CREDITS'],
    });
    expect(publicCapabilities).not.toHaveProperty('pricingMetadataVersion');
    expect(JSON.stringify(publicCapabilities)).not.toContain('internalEndpoint');
  });

  it('classifies unrecognized internal configuration as stable input failure', () => {
    let failure: unknown;

    try {
      new ProviderRegistry([
        {
          ...registry.get('OPENAI'),
          internalEndpoint: 'https://should-not-enter-the-registry.test',
        },
      ]);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ProviderFailure);
    expect(failure).toMatchObject({ code: 'INPUT_INVALID', retryable: false });
  });
});
