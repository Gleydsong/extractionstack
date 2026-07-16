import { describe, expect, it } from 'vitest';
import { ProviderFailure } from './provider-errors';
import { ProviderRegistry } from './provider-registry';

const configuredCapabilities = [
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
] as const;

const registry = new ProviderRegistry(configuredCapabilities, {
  allowTestProvider: true,
});

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

  it('returns the exact public capability shape without internal details', () => {
    const publicCapabilities = registry.listPublic().find(({ provider }) => provider === 'OPENAI');

    expect(Object.keys(publicCapabilities ?? {}).sort()).toEqual(
      [
        'circuitBreakerOpen',
        'contextWindowTokens',
        'credentialModes',
        'enabled',
        'maxOutputTokens',
        'models',
        'previewEligible',
        'provider',
        'supportsCancellation',
        'supportsCredentialRefresh',
        'supportsStructuredOutput',
      ].sort(),
    );
    expect(publicCapabilities).toMatchObject({
      credentialModes: ['API_KEY', 'PLATFORM_CREDITS'],
    });
    expect(JSON.stringify(publicCapabilities)).not.toContain('oauthScopes');
    expect(JSON.stringify(publicCapabilities)).not.toContain('pricingMetadataVersion');
    expect(JSON.stringify(publicCapabilities)).not.toContain('internalEndpoint');
  });

  it('sanitizes rejected configuration from stable input failures', () => {
    let failure: unknown;
    const rejectedEndpoint = 'https://secret-internal-endpoint.test/private';

    try {
      new ProviderRegistry([
        {
          ...registry.get('OPENAI'),
          internalEndpoint: rejectedEndpoint,
        },
      ]);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ProviderFailure);
    expect(failure).toMatchObject({ code: 'INPUT_INVALID', retryable: false });
    expect(failure).not.toHaveProperty('cause');
    expect(JSON.stringify(failure)).not.toContain('internalEndpoint');
    expect(JSON.stringify(failure)).not.toContain(rejectedEndpoint);
    expect(Object.values(failure as object).join(' ')).not.toContain(rejectedEndpoint);
  });

  it('rejects an enabled fake provider unless test policy is explicit', () => {
    expect(() => new ProviderRegistry([registry.get('FAKE')])).toThrow('INPUT_INVALID');
  });

  it('exposes fake capabilities only when test policy is explicit', () => {
    const testRegistry = new ProviderRegistry([registry.get('FAKE')], {
      allowTestProvider: true,
    });

    expect(testRegistry.listPublic().map(({ provider }) => provider)).toEqual(['FAKE']);
  });

  it('sanitizes unsafe provider request identifiers from failures', () => {
    const failure = new ProviderFailure('PROVIDER_UNAVAILABLE', {
      providerRequestId: 'unsafe request identifier with spaces',
    });

    expect(failure.providerRequestId).toBeNull();
  });
});
