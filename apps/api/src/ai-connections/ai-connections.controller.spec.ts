import { describe, expect, it, vi } from 'vitest';
import type { AiConnectionsService } from './ai-connections.service.js';
import type { ProviderRegistry } from '@extractionstack/llm-core';
import { AiConnectionsController, AiProvidersController } from './ai-connections.controller.js';

describe('AiConnectionsController', () => {
  it('passes only the authenticated actor and validated API-key command to the service', async () => {
    const addApiKey = vi.fn().mockResolvedValue({ id: 'cm1234567890' });
    const controller = new AiConnectionsController({
      addApiKey,
    } as unknown as AiConnectionsService);
    const actor = { sub: 'auth0|owner', roles: ['user'] as ('user' | 'admin')[] };
    const command = { provider: 'OPENAI' as const, displayLabel: 'Primary', apiKey: 'secret' };

    await controller.addApiKey({ user: actor }, command, 'ai-connection:0001');

    expect(addApiKey).toHaveBeenCalledWith(actor, command, 'ai-connection:0001');
  });

  it('requires an idempotency key on authenticated mutations', async () => {
    const controller = new AiConnectionsController({
      addApiKey: vi.fn(),
    } as unknown as AiConnectionsService);
    const actor = { sub: 'auth0|owner', roles: ['user'] as ('user' | 'admin')[] };

    expect(() =>
      controller.addApiKey(
        { user: actor },
        { provider: 'OPENAI', displayLabel: 'Primary', apiKey: 'secret-key' },
        undefined,
      ),
    ).toThrow('invalid idempotency key');
  });

  it('does not require an application user on the signed one-time OAuth callback', async () => {
    const finishOAuth = vi.fn().mockResolvedValue({ id: 'cm1234567890' });
    const controller = new AiConnectionsController({
      finishOAuth,
    } as unknown as AiConnectionsService);

    await controller.finishOAuth('GEMINI', 'random-state', 'authorization-code');

    expect(finishOAuth).toHaveBeenCalledWith('GEMINI', 'random-state', 'authorization-code');
  });
});

describe('AiProvidersController', () => {
  it('returns only the registry public capability view', () => {
    const capabilities = {
      provider: 'OPENAI',
      credentialModes: ['API_KEY', 'PLATFORM_CREDITS'],
      models: ['gpt-test'],
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_384,
      supportsStructuredOutput: true,
      supportsCancellation: false,
      supportsCredentialRefresh: false,
      previewEligible: true,
      enabled: true,
      circuitBreakerOpen: false,
    };
    const listPublic = vi.fn().mockReturnValue([capabilities]);
    const controller = new AiProvidersController({ listPublic } as unknown as ProviderRegistry);

    expect(controller.list()).toEqual([capabilities]);
    expect(listPublic).toHaveBeenCalledOnce();
  });

  it('rejects a registry response that leaks internal capability fields', () => {
    const listPublic = vi.fn().mockReturnValue([
      {
        provider: 'OPENAI',
        credentialModes: ['API_KEY'],
        models: ['gpt-test'],
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_384,
        supportsStructuredOutput: true,
        supportsCancellation: false,
        supportsCredentialRefresh: false,
        previewEligible: true,
        enabled: true,
        circuitBreakerOpen: false,
        internalEndpoint: 'https://internal.example.test',
      },
    ]);
    const controller = new AiProvidersController({ listPublic } as unknown as ProviderRegistry);

    expect(() => controller.list()).toThrow();
  });
});
