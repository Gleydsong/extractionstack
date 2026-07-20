import { useEffect, useMemo, useRef, useState } from 'react';
import type { AiConnection, PublicProviderCapabilities } from '@extractionstack/shared';
import { Header } from '../auth/Header';
import { ApiKeyConnectionForm } from './ApiKeyConnectionForm';
import {
  useAiConnectionsApi,
  getAiConnectionErrorMessage,
  type AiConnectionsApi,
  type ApiKeyCommand,
} from './useAiConnectionsApi';
import { fingerprintApiKeyCommand, IdempotencyOperationStore } from './idempotency';

const PROVIDER_LABELS = {
  FAKE: 'Provedor de teste',
  OPENAI: 'OpenAI',
  GEMINI: 'Gemini',
} as const;

const CONNECTION_STATE_LABELS = {
  PENDING: 'Pendente',
  ACTIVE: 'Ativa',
  EXPIRED: 'Expirada',
  REVOKED: 'Revogada',
  INVALID: 'Inválida',
} as const;

const CREDENTIAL_MODE_LABELS = {
  OAUTH: 'Google OAuth',
  API_KEY: 'Chave de API',
  PLATFORM_CREDITS: 'Créditos da plataforma',
} as const;

export function AiConnectionsPage({ api: injected }: { api?: AiConnectionsApi }): JSX.Element {
  const api = useAiConnectionsApi(injected);
  const [providers, setProviders] = useState<readonly PublicProviderCapabilities[]>([]);
  const [connections, setConnections] = useState<AiConnection[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [confirmingRevokeId, setConfirmingRevokeId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFocusVersion, setStatusFocusVersion] = useState(0);
  const idempotency = useRef(new IdempotencyOperationStore());
  const statusRef = useRef<HTMLParagraphElement>(null);
  const revokeTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const revokeConfirmRefs = useRef(new Map<string, HTMLButtonElement>());
  const restoreRevokeFocusId = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([api.listProviders(), api.listConnections()])
      .then(([providerList, connectionList]) => {
        if (!active) return;
        setProviders(providerList);
        setConnections(connectionList);
      })
      .catch((cause: unknown) => {
        if (active) setError(getAiConnectionErrorMessage(cause));
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    if (confirmingRevokeId) {
      revokeConfirmRefs.current.get(confirmingRevokeId)?.focus();
      return;
    }
    const id = restoreRevokeFocusId.current;
    if (id) {
      restoreRevokeFocusId.current = null;
      revokeTriggerRefs.current.get(id)?.focus();
    }
  }, [confirmingRevokeId]);

  useEffect(() => {
    if (statusFocusVersion > 0) statusRef.current?.focus();
  }, [statusFocusVersion]);

  const apiKeyCapableProviders = useMemo(
    () =>
      providers.filter(
        (provider) =>
          (provider.provider === 'OPENAI' || provider.provider === 'GEMINI') &&
          provider.enabled &&
          !provider.circuitBreakerOpen &&
          provider.credentialModes.includes('API_KEY'),
      ),
    [providers],
  );

  const apiKeyProviders = useMemo(
    () =>
      apiKeyCapableProviders.filter(
        (provider) =>
          !connections.some(
            (connection) =>
              connection.provider === provider.provider &&
              connection.credentialMode === 'API_KEY' &&
              connection.state !== 'REVOKED',
          ),
      ),
    [apiKeyCapableProviders, connections],
  );

  const geminiOAuthAvailable = providers.some(
    (provider) =>
      provider.provider === 'GEMINI' &&
      provider.enabled &&
      !provider.circuitBreakerOpen &&
      provider.credentialModes.some((mode) => mode === 'OAUTH'),
  );
  const hasGeminiOAuthConnection = connections.some(
    (connection) =>
      connection.provider === 'GEMINI' &&
      connection.credentialMode === 'OAUTH' &&
      connection.state !== 'REVOKED',
  );
  const hasAvailableProviders = providers.some(
    (provider) => provider.enabled && !provider.circuitBreakerOpen,
  );

  function replaceConnection(nextConnection: AiConnection): void {
    setConnections((current) => {
      const index = current.findIndex((connection) => connection.id === nextConnection.id);
      if (index === -1) return [...current, nextConnection];
      return current.map((connection) =>
        connection.id === nextConnection.id ? nextConnection : connection,
      );
    });
  }

  async function addApiKey(command: ApiKeyCommand): Promise<void> {
    const operation = 'add-api-key';
    setPendingAction('api-key');
    setStatus('Validando a conexão…');
    setError(null);
    try {
      const fingerprint = await fingerprintApiKeyCommand(command);
      const nextConnection = await api.addApiKey(
        command,
        idempotency.current.acquire(operation, 'ai-connect', fingerprint),
      );
      idempotency.current.settle(operation);
      replaceConnection(nextConnection);
      announceSuccess('Conexão adicionada e validada com sucesso.');
    } catch (cause) {
      idempotency.current.settle(operation, cause);
      setStatus(null);
      setError(getAiConnectionErrorMessage(cause));
    } finally {
      setPendingAction(null);
    }
  }

  async function startGeminiOAuth(): Promise<void> {
    const operation = 'start-gemini-oauth';
    setPendingAction('oauth');
    setStatus('Preparando conexão segura com o Google…');
    setError(null);
    try {
      const result = await api.startGeminiOAuth(idempotency.current.acquire(operation, 'ai-oauth'));
      idempotency.current.settle(operation);
      window.location.assign(result.authorizationUrl);
    } catch (cause) {
      idempotency.current.settle(operation, cause);
      setStatus(null);
      setError(getAiConnectionErrorMessage(cause));
      setPendingAction(null);
    }
  }

  async function validate(connection: AiConnection): Promise<void> {
    const operation = `validate:${connection.id}`;
    setPendingAction(`validate:${connection.id}`);
    setStatus('Validando a conexão…');
    setError(null);
    try {
      replaceConnection(
        await api.validateConnection(
          connection.id,
          idempotency.current.acquire(operation, 'ai-validate'),
        ),
      );
      idempotency.current.settle(operation);
      announceSuccess('Conexão validada com sucesso.');
    } catch (cause) {
      idempotency.current.settle(operation, cause);
      setStatus(null);
      setError(getAiConnectionErrorMessage(cause));
    } finally {
      setPendingAction(null);
    }
  }

  async function revoke(connection: AiConnection): Promise<void> {
    const operation = `revoke:${connection.id}`;
    setPendingAction(`revoke:${connection.id}`);
    setStatus('Revogando a conexão…');
    setError(null);
    try {
      replaceConnection(
        await api.revokeConnection(
          connection.id,
          idempotency.current.acquire(operation, 'ai-revoke'),
        ),
      );
      idempotency.current.settle(operation);
      setConfirmingRevokeId(null);
      announceSuccess('Conexão revogada.');
    } catch (cause) {
      idempotency.current.settle(operation, cause);
      setStatus(null);
      setError(getAiConnectionErrorMessage(cause));
    } finally {
      setPendingAction(null);
    }
  }

  function announceSuccess(message: string): void {
    setStatus(message);
    setStatusFocusVersion((version) => version + 1);
  }

  function cancelRevoke(id: string): void {
    restoreRevokeFocusId.current = id;
    setConfirmingRevokeId(null);
  }

  return (
    <div className="app">
      <Header />
      <main className="connections-page">
        <header className="page-heading">
          <h1>Conexões de IA</h1>
          <p className="lead">
            Autorize os provedores usados para gerar prompts e prévias. Credenciais enviadas não
            voltam a ser exibidas.
          </p>
        </header>

        {error ? (
          <p className="connection-message error-text" role="alert">
            {error}
          </p>
        ) : null}
        {status ? (
          <p
            ref={statusRef}
            className="connection-message"
            role="status"
            aria-live="polite"
            tabIndex={-1}
          >
            {status}
          </p>
        ) : null}

        {isLoading ? (
          <p role="status">Carregando conexões…</p>
        ) : (
          <>
            <section className="connections-section" aria-labelledby="saved-connections-heading">
              <div className="section-heading">
                <div>
                  <h2 id="saved-connections-heading">Conexões salvas</h2>
                  <p className="section-description">
                    Somente metadados seguros e valores mascarados.
                  </p>
                </div>
              </div>

              {connections.length === 0 ? (
                <p className="empty-state">Nenhum provedor conectado. Escolha uma opção abaixo.</p>
              ) : (
                <ul className="connections-list">
                  {connections.map((connection) => (
                    <li key={connection.id} className="connection-row">
                      <div className="connection-summary">
                        <div>
                          <strong>{connection.displayLabel}</strong>
                          <span
                            className={`connection-state state-${connection.state.toLowerCase()}`}
                          >
                            {CONNECTION_STATE_LABELS[connection.state]}
                          </span>
                        </div>
                        <p>
                          {PROVIDER_LABELS[connection.provider]} ·{' '}
                          {CREDENTIAL_MODE_LABELS[connection.credentialMode]}
                          {connection.maskedCredential ? ` · ${connection.maskedCredential}` : ''}
                        </p>
                        {connection.validatedAt ? (
                          <p className="connection-meta">
                            Validada em {formatDate(connection.validatedAt)}
                          </p>
                        ) : null}
                      </div>

                      {connection.state !== 'REVOKED' ? (
                        <div className="connection-actions">
                          <button
                            type="button"
                            onClick={() => void validate(connection)}
                            disabled={pendingAction !== null}
                          >
                            {pendingAction === `validate:${connection.id}`
                              ? 'Validando…'
                              : 'Validar novamente'}
                          </button>
                          {confirmingRevokeId === connection.id ? (
                            <div
                              className="revoke-confirmation"
                              role="group"
                              aria-label="Confirmar revogação"
                              onKeyDown={(event) => {
                                if (event.key === 'Escape') cancelRevoke(connection.id);
                              }}
                            >
                              <span>Revogar esta conexão?</span>
                              <button
                                ref={(element) => {
                                  if (element)
                                    revokeConfirmRefs.current.set(connection.id, element);
                                  else revokeConfirmRefs.current.delete(connection.id);
                                }}
                                className="danger-action"
                                type="button"
                                onClick={() => void revoke(connection)}
                                disabled={pendingAction !== null}
                              >
                                Confirmar revogação
                              </button>
                              <button
                                type="button"
                                onClick={() => cancelRevoke(connection.id)}
                                disabled={pendingAction !== null}
                              >
                                Manter conexão
                              </button>
                            </div>
                          ) : (
                            <button
                              ref={(element) => {
                                if (element) revokeTriggerRefs.current.set(connection.id, element);
                                else revokeTriggerRefs.current.delete(connection.id);
                              }}
                              className="danger-action"
                              type="button"
                              onClick={() => setConfirmingRevokeId(connection.id)}
                              disabled={pendingAction !== null}
                            >
                              Revogar
                            </button>
                          )}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="connections-section" aria-labelledby="api-key-heading">
              <h2 id="api-key-heading">Conectar com chave de API</h2>
              <p className="section-description">
                A chave fica visível apenas enquanto você preenche este formulário.
              </p>
              {!hasAvailableProviders ? (
                <p className="empty-state">Nenhum provedor está disponível no momento.</p>
              ) : apiKeyProviders.length > 0 ? (
                <ApiKeyConnectionForm
                  providers={apiKeyProviders}
                  isSubmitting={pendingAction === 'api-key'}
                  onSubmit={addApiKey}
                />
              ) : apiKeyCapableProviders.length === 0 ? (
                <p className="empty-state">
                  Nenhum provedor com chave de API está disponível no momento.
                </p>
              ) : (
                <p className="empty-state">
                  Todos os provedores com chave disponível já estão conectados.
                </p>
              )}
            </section>

            {geminiOAuthAvailable ? (
              <section className="connections-section" aria-labelledby="oauth-heading">
                <h2 id="oauth-heading">Conectar com Google</h2>
                <p className="section-description">
                  OAuth está disponível somente para o Gemini e usa autorização com
                  redirecionamento.
                </p>
                {hasGeminiOAuthConnection ? (
                  <p className="empty-state">O Gemini já possui uma conexão OAuth.</p>
                ) : (
                  <button
                    className="primary-action"
                    type="button"
                    onClick={() => void startGeminiOAuth()}
                    disabled={pendingAction !== null}
                  >
                    {pendingAction === 'oauth' ? 'Conectando…' : 'Conectar Gemini com Google'}
                  </button>
                )}
              </section>
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}
