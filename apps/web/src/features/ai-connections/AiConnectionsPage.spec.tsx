import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiConnection } from '@extractionstack/shared';
import { AiConnectionsPage } from './AiConnectionsPage';
import {
  AiConnectionsClientError,
  AiConnectionsClient,
  getAiConnectionErrorMessage,
  type AiConnectionsApi,
  type PublicProviderCapabilities,
} from './useAiConnectionsApi';

const now = '2026-07-17T12:00:00.000Z';

const capabilities: readonly PublicProviderCapabilities[] = [
  {
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
  },
  {
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
  },
];

function connection(overrides: Partial<AiConnection> = {}): AiConnection {
  return {
    id: 'cm1234567890abcdefghijkl',
    provider: 'OPENAI',
    displayLabel: 'OpenAI principal',
    credentialMode: 'API_KEY',
    state: 'ACTIVE',
    maskedCredential: '…cret',
    scopes: [],
    expiresAt: null,
    validatedAt: now,
    lastUsedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createApi(overrides: Partial<AiConnectionsApi> = {}): AiConnectionsApi {
  return {
    listProviders: vi.fn().mockResolvedValue(capabilities),
    listConnections: vi.fn().mockResolvedValue([]),
    addApiKey: vi.fn().mockResolvedValue(connection()),
    startGeminiOAuth: vi.fn().mockResolvedValue({
      state: 'a'.repeat(43),
      authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=${'a'.repeat(43)}`,
    }),
    validateConnection: vi.fn().mockImplementation(async (id: string) => connection({ id })),
    revokeConnection: vi
      .fn()
      .mockImplementation(async (id: string) => connection({ id, state: 'REVOKED' })),
    ...overrides,
  };
}

function renderPage(api: AiConnectionsApi): void {
  render(
    <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
      <AiConnectionsPage api={api} />
    </MemoryRouter>,
  );
}

describe('AiConnectionsPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      'cb6d0478-a915-4d09-bde4-b6270d677e6a',
    );
  });

  it('submits a key but never renders it again', async () => {
    const api = createApi();
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    renderPage(api);

    const input = await screen.findByLabelText('Chave de API');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'off');

    fireEvent.change(input, { target: { value: 'sk-test-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Conectar' }));

    expect(await screen.findByText(/Chave de API · …cret/)).toBeVisible();
    expect(api.addApiKey).toHaveBeenCalledWith(
      {
        provider: 'OPENAI',
        displayLabel: 'OpenAI principal',
        apiKey: 'sk-test-secret',
      },
      'ai-connect:cb6d0478-a915-4d09-bde4-b6270d677e6a',
    );
    expect(screen.queryByDisplayValue('sk-test-secret')).not.toBeInTheDocument();
    expect(screen.queryByText('sk-test-secret')).not.toBeInTheDocument();
    expect(storageWrite).not.toHaveBeenCalled();
  });

  it('clears the controlled secret even when validation fails', async () => {
    const api = createApi({ addApiKey: vi.fn().mockRejectedValue(new Error('provider secret')) });
    renderPage(api);

    const input = await screen.findByLabelText('Chave de API');
    fireEvent.change(input, { target: { value: 'sk-private-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Conectar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Não foi possível concluir a ação. Tente novamente.',
    );
    expect(input).toHaveValue('');
    expect(screen.queryByText(/provider secret|sk-private-value/)).not.toBeInTheDocument();
  });

  it('offers OAuth only when the capability registry allows it', async () => {
    renderPage(createApi());

    expect(await screen.findByRole('button', { name: 'Conectar Gemini com Google' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /OpenAI.*Google/ })).not.toBeInTheDocument();
  });

  it('announces validation and updates the connection metadata', async () => {
    const current = connection({ state: 'INVALID', maskedCredential: '…cret' });
    const api = createApi({
      listConnections: vi.fn().mockResolvedValue([current]),
      validateConnection: vi
        .fn()
        .mockResolvedValue(
          connection({ id: current.id, state: 'ACTIVE', maskedCredential: '…cret' }),
        ),
    });
    renderPage(api);

    fireEvent.click(await screen.findByRole('button', { name: 'Validar novamente' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Conexão validada com sucesso.');
    expect(api.validateConnection).toHaveBeenCalledWith(
      current.id,
      'ai-validate:cb6d0478-a915-4d09-bde4-b6270d677e6a',
    );
  });

  it('requires an explicit confirmation before revoking a connection', async () => {
    const current = connection();
    const api = createApi({ listConnections: vi.fn().mockResolvedValue([current]) });
    renderPage(api);

    fireEvent.click(await screen.findByRole('button', { name: 'Revogar' }));

    expect(api.revokeConnection).not.toHaveBeenCalled();
    expect(screen.getByText('Revogar esta conexão?')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar revogação' }));

    await waitFor(() =>
      expect(api.revokeConnection).toHaveBeenCalledWith(
        current.id,
        'ai-revoke:cb6d0478-a915-4d09-bde4-b6270d677e6a',
      ),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Conexão revogada.');
  });

  it('moves focus into revoke confirmation, restores it on cancel, and focuses success status', async () => {
    const current = connection();
    renderPage(createApi({ listConnections: vi.fn().mockResolvedValue([current]) }));

    const revokeButton = await screen.findByRole('button', { name: 'Revogar' });
    fireEvent.click(revokeButton);
    expect(screen.getByRole('button', { name: 'Confirmar revogação' })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('group', { name: 'Confirmar revogação' }), {
      key: 'Escape',
    });
    const restoredRevokeButton = screen.getByRole('button', { name: 'Revogar' });
    expect(restoredRevokeButton).toHaveFocus();

    fireEvent.click(restoredRevokeButton);
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar revogação' }));
    const successStatus = await screen.findByText('Conexão revogada.');
    expect(successStatus).toHaveFocus();
  });

  it('reuses an uncertain idempotency key and rotates it after a definitive HTTP failure', async () => {
    vi.mocked(globalThis.crypto.randomUUID)
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');
    const addApiKey = vi
      .fn()
      .mockRejectedValueOnce(new AiConnectionsClientError('NETWORK_ERROR'))
      .mockRejectedValueOnce(new AiConnectionsClientError('CONNECTION_INVALID'))
      .mockResolvedValueOnce(connection());
    renderPage(createApi({ addApiKey }));

    const submit = async (secret: string, expectedCalls: number): Promise<void> => {
      fireEvent.change(await screen.findByLabelText('Chave de API'), { target: { value: secret } });
      fireEvent.click(screen.getByRole('button', { name: 'Conectar' }));
      await waitFor(() => expect(addApiKey).toHaveBeenCalledTimes(expectedCalls));
    };

    await submit('sk-same-secret', 1);
    await screen.findByRole('alert');
    await submit('sk-same-secret', 2);
    await screen.findByRole('alert');
    await submit('sk-same-secret', 3);
    await screen.findByText(/Chave de API · …cret/);

    const keys = addApiKey.mock.calls.map((call) => call[1]);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it('does not reuse an uncertain add-key operation for a different credential', async () => {
    vi.mocked(globalThis.crypto.randomUUID)
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');
    const addApiKey = vi.fn().mockRejectedValue(new AiConnectionsClientError('NETWORK_ERROR'));
    renderPage(createApi({ addApiKey }));

    const input = await screen.findByLabelText('Chave de API');
    fireEvent.change(input, { target: { value: 'sk-first-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Conectar' }));
    await screen.findByRole('alert');
    fireEvent.change(input, { target: { value: 'sk-other-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Conectar' }));
    await waitFor(() => expect(addApiKey).toHaveBeenCalledTimes(2));

    expect(addApiKey.mock.calls[1]?.[1]).not.toBe(addApiKey.mock.calls[0]?.[1]);
  });

  it('explains when provider capabilities are unavailable', async () => {
    renderPage(createApi({ listProviders: vi.fn().mockResolvedValue([]) }));

    expect(await screen.findByText('Nenhum provedor está disponível no momento.')).toBeVisible();
  });

  it('labels platform-credit connections accurately', async () => {
    renderPage(
      createApi({
        listConnections: vi.fn().mockResolvedValue([
          connection({
            provider: 'FAKE',
            credentialMode: 'PLATFORM_CREDITS',
            maskedCredential: null,
          }),
        ]),
      }),
    );

    expect(await screen.findByText(/Créditos da plataforma/)).toBeVisible();
  });
});

describe('AiConnectionsClient response validation', () => {
  it('rejects provider capability responses with unknown fields', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ ...capabilities[0], internalPrice: 'secret' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new AiConnectionsClient(async () => 'token', fetcher);

    await expect(client.listProviders()).rejects.toThrow('INVALID_RESPONSE');
  });

  it('rejects an OAuth authorization URL that does not use HTTPS', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ state: 'a'.repeat(43), authorizationUrl: 'http://example.test/oauth' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    const client = new AiConnectionsClient(
      async () => 'token',
      fetcher,
      '',
      'http://localhost:3001/api/ai/connections/GEMINI/oauth/callback',
    );

    await expect(client.startGeminiOAuth('ai-oauth:test-key')).rejects.toThrow('INVALID_RESPONSE');
  });

  it.each([
    'https://evil.example.test/o/oauth2/v2/auth',
    'https://accounts.google.com/o/oauth2/v2/auth/other',
  ])('rejects an OAuth URL outside the trusted authorization endpoint: %s', async (endpoint) => {
    const state = 'a'.repeat(43);
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ state, authorizationUrl: `${endpoint}?state=${state}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new AiConnectionsClient(
      async () => 'token',
      fetcher,
      'http://localhost:3001',
      undefined,
    );

    await expect(client.startGeminiOAuth('ai-oauth:test-key')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('derives the default callback from the effective API origin', async () => {
    const state = 'a'.repeat(43);
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          state,
          authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = new AiConnectionsClient(
      async () => 'token',
      fetcher,
      'http://localhost:3001',
      undefined,
    );

    await client.startGeminiOAuth('ai-oauth:test-key');

    expect(fetcher).toHaveBeenCalledWith(
      'http://localhost:3001/api/ai/connections/GEMINI/oauth/start',
      expect.objectContaining({
        body: JSON.stringify({
          redirectUri: 'http://localhost:3001/api/ai/connections/GEMINI/oauth/callback',
        }),
      }),
    );
  });

  it.each([
    ['UNAUTHENTICATED', 'Sua sessão expirou. Entre novamente para continuar.'],
    ['FORBIDDEN', 'Você não tem permissão para gerenciar conexões de IA.'],
    ['RATE_LIMITED', 'Muitas tentativas foram feitas. Aguarde um pouco e tente novamente.'],
    [
      'NETWORK_ERROR',
      'Não foi possível acessar o servidor. Verifique sua conexão e tente novamente.',
    ],
    ['INVALID_RESPONSE', 'O servidor retornou uma resposta inválida. Tente novamente.'],
    ['CONNECTION_INVALID', 'A credencial foi recusada ou precisa ser atualizada.'],
    ['DEPENDENCY_UNAVAILABLE', 'O provedor está temporariamente indisponível. Tente mais tarde.'],
    [
      'OAUTH_EXCHANGE_FAILED',
      'Não foi possível concluir a autorização com o Google. Tente novamente.',
    ],
  ] as const)('maps %s to safe natural language', (code, expected) => {
    expect(getAiConnectionErrorMessage(new AiConnectionsClientError(code))).toBe(expected);
  });

  it('uses a safe fallback without exposing unknown error messages', () => {
    expect(getAiConnectionErrorMessage(new Error('sk-secret internal failure'))).toBe(
      'Não foi possível concluir a ação. Tente novamente.',
    );
  });
});
