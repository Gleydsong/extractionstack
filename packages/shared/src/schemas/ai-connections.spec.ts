import { describe, expect, it } from 'vitest';
import { GeminiOAuthStartResponseSchema, PublicProviderCapabilitiesSchema } from './ai-connections';

const publicCapabilities = {
  provider: 'GEMINI',
  credentialModes: ['OAUTH', 'API_KEY', 'PLATFORM_CREDITS'],
  models: ['gemini-test'],
  contextWindowTokens: 1_000_000,
  maxOutputTokens: 8_192,
  supportsStructuredOutput: true,
  supportsCancellation: false,
  supportsCredentialRefresh: true,
  previewEligible: true,
  enabled: true,
  circuitBreakerOpen: false,
} as const;

describe('PublicProviderCapabilitiesSchema', () => {
  it('accepts the public provider capability contract', () => {
    expect(PublicProviderCapabilitiesSchema.parse(publicCapabilities)).toEqual(publicCapabilities);
  });

  it('rejects internal fields and unsupported provider-mode combinations', () => {
    expect(
      PublicProviderCapabilitiesSchema.safeParse({
        ...publicCapabilities,
        internalEndpoint: 'https://internal.example.test',
      }).success,
    ).toBe(false);
    expect(
      PublicProviderCapabilitiesSchema.safeParse({
        ...publicCapabilities,
        provider: 'OPENAI',
        credentialModes: ['OAUTH', 'API_KEY'],
      }).success,
    ).toBe(false);
    expect(
      PublicProviderCapabilitiesSchema.safeParse({
        ...publicCapabilities,
        provider: 'FAKE',
        credentialModes: ['API_KEY'],
      }).success,
    ).toBe(false);
  });
});

describe('GeminiOAuthStartResponseSchema', () => {
  const state = 'a'.repeat(43);

  it('accepts a strict HTTPS response whose URL contains the same state', () => {
    expect(
      GeminiOAuthStartResponseSchema.safeParse({
        state,
        authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
      }).success,
    ).toBe(true);
  });

  it.each([
    [
      'unknown field',
      { state, authorizationUrl: `https://example.test/auth?state=${state}`, extra: true },
    ],
    ['HTTP URL', { state, authorizationUrl: `http://example.test/auth?state=${state}` }],
    ['missing URL state', { state, authorizationUrl: 'https://example.test/auth' }],
    [
      'different URL state',
      { state, authorizationUrl: `https://example.test/auth?state=${'b'.repeat(43)}` },
    ],
  ])('rejects %s', (_name, value) => {
    expect(GeminiOAuthStartResponseSchema.safeParse(value).success).toBe(false);
  });
});
