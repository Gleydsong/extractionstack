import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type {
  AiConnection,
  CredentialMode,
  PromptGenerationJob,
  PromptPreview,
  PromptProject,
  PromptVersionDetail,
  PromptVersionCostEstimate,
  PromptVersionSummary,
  PublicProviderCapabilities,
} from '@extractionstack/shared';
import { Header } from '../auth/Header';
import {
  pollPromptJob,
  promptErrorMessage,
  stableIdempotencyKey,
  usePromptApi,
  type PromptApi,
} from './usePromptApi';

type ExecutionChoice = {
  provider: PublicProviderCapabilities['provider'];
  model: string;
  mode: CredentialMode;
  connectionId: string | null;
  maximumCostMinor: string;
  consent: boolean;
};

export function PromptWorkspacePage({ api: injected }: { api?: PromptApi }): JSX.Element {
  const { id = '' } = useParams();
  const api = usePromptApi(injected);
  const [project, setProject] = useState<PromptProject | null>(null);
  const [versions, setVersions] = useState<PromptVersionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [version, setVersion] = useState<PromptVersionDetail | null>(null);
  const [editContent, setEditContent] = useState('');
  const [preview, setPreview] = useState<PromptPreview | null>(null);
  const [providers, setProviders] = useState<readonly PublicProviderCapabilities[]>([]);
  const [connections, setConnections] = useState<AiConnection[]>([]);
  const [choice, setChoice] = useState<ExecutionChoice>({
    provider: 'OPENAI',
    model: '',
    mode: 'PLATFORM_CREDITS',
    connectionId: null,
    maximumCostMinor: '',
    consent: false,
  });
  const [destination, setDestination] = useState<
    'codex' | 'chatgpt' | 'claude' | 'gemini' | 'cursor' | 'lovable' | 'bolt'
  >('codex');
  const [activeJob, setActiveJob] = useState<PromptGenerationJob | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [trackingInterrupted, setTrackingInterrupted] = useState(false);
  const [quoteOperation, setQuoteOperation] = useState<'ADAPT' | 'PREVIEW'>('ADAPT');
  const [costEstimate, setCostEstimate] = useState<PromptVersionCostEstimate | null>(null);
  const [costEstimateBusy, setCostEstimateBusy] = useState(false);
  const [costEstimateError, setCostEstimateError] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const controllerRef = useRef<AbortController | null>(null);
  const operationKeys = useRef(new Map<string, string>());
  const activeAttempt = useRef<{
    kind: 'adapt' | 'preview';
    operation: string;
    job: PromptGenerationJob;
  } | null>(null);
  const quoteFingerprintRef = useRef<string | null>(null);
  const errorRef = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const loadVersion = useCallback(
    async (versionId: string, signal?: AbortSignal) => {
      const next = await api.getVersion(versionId, signal);
      setVersion(next);
      setEditContent(next.content);
    },
    [api],
  );
  const refreshVersions = useCallback(
    async (signal?: AbortSignal) => {
      const result = await api.listVersions(id, undefined, signal);
      setVersions(result.items);
      setNextCursor(result.nextCursor);
      return result.items;
    },
    [api, id],
  );

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    void Promise.all([
      api.getProject(id, controller.signal),
      api.listVersions(id, undefined, controller.signal),
      api.listProviders(controller.signal),
      api.listConnections(controller.signal),
    ])
      .then(([nextProject, result, providerList, connectionList]) => {
        setProject(nextProject);
        setVersions(result.items);
        setNextCursor(result.nextCursor);
        const available = providerList.filter((item) => item.enabled && !item.circuitBreakerOpen);
        setProviders(available);
        setConnections(connectionList);
        const first = available[0];
        if (first)
          setChoice((current) => ({
            ...current,
            provider: first.provider,
            model: first.models[0] ?? '',
            mode: first.credentialModes[0],
          }));
        const selectedId = nextProject.currentVersionId ?? result.items[0]?.id;
        if (selectedId) return loadVersion(selectedId, controller.signal);
      })
      .catch((cause) => {
        if (!(cause instanceof DOMException && cause.name === 'AbortError'))
          setError(promptErrorMessage(cause));
      });
    return () => controller.abort();
  }, [api, id, loadVersion]);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const provider = providers.find((item) => item.provider === choice.provider);
  const availableConnections = useMemo(
    () =>
      connections.filter(
        (item) =>
          item.provider === choice.provider &&
          item.credentialMode === choice.mode &&
          item.state === 'ACTIVE',
      ),
    [choice.mode, choice.provider, connections],
  );
  const jobActive =
    mutationBusy ||
    trackingInterrupted ||
    Boolean(activeJob && ['QUEUED', 'RUNNING', 'CANCEL_REQUESTED'].includes(activeJob.status));
  const quoteFingerprint = version
    ? versionQuoteFingerprint(
        version.id,
        choice.provider,
        choice.model,
        quoteOperation,
        destination,
      )
    : null;

  useEffect(() => {
    if (!version || !choice.model) {
      quoteFingerprintRef.current = null;
      setCostEstimate(null);
      return;
    }
    const controller = new AbortController();
    const fingerprint = versionQuoteFingerprint(
      version.id,
      choice.provider,
      choice.model,
      quoteOperation,
      destination,
    );
    quoteFingerprintRef.current = fingerprint;
    setCostEstimate(null);
    setCostEstimateBusy(true);
    setCostEstimateError('');
    setChoice((current) => ({ ...current, consent: false }));
    const request =
      quoteOperation === 'ADAPT'
        ? {
            provider: choice.provider,
            model: choice.model,
            operation: 'ADAPT' as const,
            destination,
          }
        : { provider: choice.provider, model: choice.model, operation: 'PREVIEW' as const };
    void api
      .estimateVersionCost(version.id, request, controller.signal)
      .then((estimate) => {
        if (controller.signal.aborted || quoteFingerprintRef.current !== fingerprint) return;
        setCostEstimate(estimate);
        setChoice((current) => ({
          ...current,
          maximumCostMinor:
            current.mode === 'PLATFORM_CREDITS'
              ? estimate.maximumCostMinor
              : current.maximumCostMinor,
          consent: false,
        }));
      })
      .catch((cause) => {
        if (
          quoteFingerprintRef.current === fingerprint &&
          !(cause instanceof DOMException && cause.name === 'AbortError')
        ) {
          setCostEstimateError(promptErrorMessage(cause));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && quoteFingerprintRef.current === fingerprint)
          setCostEstimateBusy(false);
      });
    return () => controller.abort();
  }, [api, choice.model, choice.provider, destination, quoteOperation, version]);

  async function saveEdit(): Promise<void> {
    if (!version || jobActive || editContent.trim() === version.content) return;
    setError('');
    setMutationBusy(true);
    setStatus('Salvando uma nova versão…');
    const operation = `edit:${version.id}:${editContent}`;
    try {
      const next = await api.editVersion(
        version.id,
        { content: editContent },
        keyFor(operation, 'prompt-edit'),
      );
      operationKeys.current.delete(operation);
      setVersion(next);
      setEditContent(next.content);
      await refreshVersions();
      setStatus(`Versão ${next.sequence} criada sem alterar o histórico.`);
    } catch (cause) {
      if (!isAmbiguousMutationFailure(cause)) operationKeys.current.delete(operation);
      setError(promptErrorMessage(cause));
    } finally {
      setMutationBusy(false);
    }
  }

  async function run(kind: 'adapt' | 'preview'): Promise<void> {
    const expectedOperation = kind === 'adapt' ? 'ADAPT' : 'PREVIEW';
    if (jobActive) {
      setError('Aguarde ou cancele a operação em andamento.');
      return;
    }
    if (
      !version ||
      quoteOperation !== expectedOperation ||
      !costEstimate ||
      quoteFingerprintRef.current !== quoteFingerprint ||
      !validChoice(choice, costEstimate.maximumCostMinor)
    ) {
      setError('Selecione modelo, conexão ou consentimento e teto válidos.');
      return;
    }
    setError('');
    setMutationBusy(true);
    setPreview(null);
    setStatus(kind === 'adapt' ? 'Adaptando prompt…' : 'Gerando prévia limitada…');
    const operation = `${kind}:${version.id}:${destination}:${JSON.stringify(choice)}`;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    try {
      const execution = {
        provider: choice.provider,
        model: choice.model,
        credentialMode: choice.mode,
        connectionId: choice.mode === 'PLATFORM_CREDITS' ? null : choice.connectionId,
        acceptPlatformCharge: choice.mode === 'PLATFORM_CREDITS' && choice.consent,
        maximumCostMinor: choice.mode === 'PLATFORM_CREDITS' ? choice.maximumCostMinor : null,
      } as const;
      const job =
        kind === 'adapt'
          ? await api.adapt(
              version.id,
              { ...execution, destination },
              keyFor(operation, 'prompt-adapt'),
            )
          : await api.preview(version.id, execution, keyFor(operation, 'prompt-preview'));
      activeAttempt.current = { kind, operation, job };
      setTrackingInterrupted(false);
      setActiveJob(job);
      await finishJob(kind, operation, job, controller);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
        if (!isAmbiguousMutationFailure(cause)) {
          operationKeys.current.delete(operation);
          activeAttempt.current = null;
          setTrackingInterrupted(false);
        } else if (activeAttempt.current?.operation === operation) {
          setTrackingInterrupted(true);
        }
        setError(promptErrorMessage(cause));
      }
    } finally {
      setMutationBusy(false);
    }
  }

  async function finishJob(
    kind: 'adapt' | 'preview',
    operation: string,
    job: PromptGenerationJob,
    controller: AbortController,
  ): Promise<void> {
    const terminal = await pollPromptJob(api, job.id, controller.signal, (next) => {
      setActiveJob(next);
      setStatus(next.message);
    });
    setTrackingInterrupted(false);
    activeAttempt.current = { kind, operation, job: terminal };
    setActiveJob(terminal);
    if (terminal.status !== 'SUCCEEDED') {
      activeAttempt.current = null;
      operationKeys.current.delete(operation);
      setError(terminal.message);
      return;
    }
    if (kind === 'preview') setPreview(await api.getPreview(job.id, controller.signal));
    else {
      const result = await refreshVersions(controller.signal);
      if (terminal.resultPromptVersionId)
        await loadVersion(terminal.resultPromptVersionId, controller.signal);
      else if (result[0]) await loadVersion(result[0].id, controller.signal);
    }
    activeAttempt.current = null;
    operationKeys.current.delete(operation);
    setStatus(kind === 'preview' ? 'Prévia concluída.' : 'Adaptação criada como nova versão.');
  }

  async function resumeTracking(): Promise<void> {
    const attempt = activeAttempt.current;
    if (!attempt || mutationBusy) return;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    setMutationBusy(true);
    setTrackingInterrupted(false);
    setError('');
    setStatus('Retomando acompanhamento da operação existente…');
    try {
      await finishJob(attempt.kind, attempt.operation, attempt.job, controller);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
        setTrackingInterrupted(true);
        setError(promptErrorMessage(cause));
      }
    } finally {
      setMutationBusy(false);
    }
  }

  async function loadMoreVersions(): Promise<void> {
    if (!nextCursor || jobActive) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const result = await api.listVersions(id, nextCursor, controller.signal);
      setVersions((current) => [
        ...current,
        ...result.items.filter((item) => !current.some((existing) => existing.id === item.id)),
      ]);
      setNextCursor(result.nextCursor);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError'))
        setError(promptErrorMessage(cause));
    }
  }

  function keyFor(operation: string, prefix: string): string {
    const existing = operationKeys.current.get(operation);
    if (existing) return existing;
    const key = stableIdempotencyKey(prefix);
    operationKeys.current.set(operation, key);
    return key;
  }

  async function cancel(): Promise<void> {
    if (!activeJob) return;
    const operation = `cancel:${activeJob.id}`;
    try {
      const updated = await api.cancel(activeJob.id, keyFor(operation, 'prompt-cancel'));
      setActiveJob(updated);
      operationKeys.current.delete(operation);
      setStatus('Cancelamento solicitado.');
    } catch (cause) {
      if (!isAmbiguousMutationFailure(cause)) operationKeys.current.delete(operation);
      setError(promptErrorMessage(cause));
    }
  }

  async function copyContent(): Promise<void> {
    if (!version) return;
    await navigator.clipboard.writeText(version.content);
    setStatus('Conteúdo copiado.');
  }

  function exportContent(extension: 'md' | 'txt'): void {
    if (!version) return;
    const url = URL.createObjectURL(
      new Blob([version.content], { type: 'text/plain;charset=utf-8' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `prompt-v${version.sequence}.${extension}`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="app">
      <Header />
      <main className="prompt-page" aria-busy={jobActive}>
        <header className="page-heading">
          <p className="eyebrow">Workspace de prompt</p>
          <h1>{project?.title ?? 'Carregando projeto…'}</h1>
          <p className="lead">
            Conteúdo natural, histórico imutável e operações vinculadas à versão selecionada.
          </p>
        </header>
        {error ? (
          <p ref={errorRef} role="alert" tabIndex={-1} className="connection-message error-text">
            {error}
          </p>
        ) : null}
        {status ? (
          <p role="status" aria-live="polite" className="connection-message">
            {status}
          </p>
        ) : null}
        <div className="prompt-workspace-layout">
          <aside aria-labelledby="version-history-heading">
            <h2 id="version-history-heading">Histórico</h2>
            {versions.length ? (
              <ol className="version-list">
                {versions.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      aria-current={version?.id === item.id ? 'true' : undefined}
                      disabled={jobActive}
                      onClick={() => void loadVersion(item.id)}
                    >
                      Versão {item.sequence} · {item.destination}
                      <span>{item.summary}</span>
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <p>Nenhuma versão concluída ainda.</p>
            )}
            {nextCursor ? (
              <button type="button" disabled={jobActive} onClick={() => void loadMoreVersions()}>
                Carregar mais versões
              </button>
            ) : null}
          </aside>
          <section aria-labelledby="prompt-content-heading">
            <h2 id="prompt-content-heading">Conteúdo</h2>
            {version ? (
              <>
                <p className="version-provenance">
                  Versão {version.sequence}
                  {version.sourceVersionId ? ' derivada de uma versão anterior' : ''} ·{' '}
                  {version.provider ?? 'Edição manual'} {version.model ?? ''}
                </p>
                <label>
                  Prompt em linguagem natural
                  <textarea
                    className="prompt-editor"
                    value={editContent}
                    required
                    disabled={jobActive}
                    onChange={(e) => setEditContent(e.target.value)}
                  />
                </label>
                <div className="prompt-actions">
                  <button type="button" disabled={jobActive} onClick={() => void saveEdit()}>
                    Salvar como nova versão
                  </button>
                  <button type="button" onClick={() => void copyContent()}>
                    Copiar
                  </button>
                  <button type="button" onClick={() => exportContent('md')}>
                    Exportar Markdown
                  </button>
                  <button type="button" onClick={() => exportContent('txt')}>
                    Exportar texto
                  </button>
                </div>
              </>
            ) : (
              <p role="status">Aguardando uma versão concluída.</p>
            )}
          </section>
        </div>
        {version ? (
          <section className="prompt-operations" aria-labelledby="operations-heading">
            <h2 id="operations-heading">Adaptar ou gerar prévia</h2>
            <p>
              Estas operações usam somente a versão selecionada. A estimativa de tokens é
              aproximada; créditos reais sempre respeitam o teto confirmado.
            </p>
            <label>
              Operação cotada
              <select
                value={quoteOperation}
                disabled={jobActive}
                onChange={(event) => {
                  setQuoteOperation(event.target.value as 'ADAPT' | 'PREVIEW');
                  setChoice({ ...choice, consent: false });
                }}
              >
                <option value="ADAPT">Adaptação</option>
                <option value="PREVIEW">Prévia</option>
              </select>
            </label>
            <div className="prompt-field-grid">
              <label>
                Provedor
                <select
                  value={choice.provider}
                  disabled={jobActive}
                  onChange={(e) => {
                    const next = providers.find((item) => item.provider === e.target.value);
                    if (next)
                      setChoice({
                        ...choice,
                        provider: next.provider,
                        model: next.models[0] ?? '',
                        mode: next.credentialModes[0],
                        connectionId: null,
                        consent: false,
                      });
                  }}
                >
                  {providers.map((item) => (
                    <option key={item.provider}>{item.provider}</option>
                  ))}
                </select>
              </label>
              <label>
                Modelo
                <select
                  value={choice.model}
                  disabled={jobActive}
                  onChange={(e) => setChoice({ ...choice, model: e.target.value })}
                >
                  {(provider?.models ?? []).map((model) => (
                    <option key={model}>{model}</option>
                  ))}
                </select>
              </label>
              <label>
                Modo
                <select
                  value={choice.mode}
                  disabled={jobActive}
                  onChange={(e) =>
                    setChoice({
                      ...choice,
                      mode: e.target.value as CredentialMode,
                      connectionId: null,
                      maximumCostMinor:
                        e.target.value === 'PLATFORM_CREDITS' && costEstimate
                          ? costEstimate.maximumCostMinor
                          : choice.maximumCostMinor,
                      consent: false,
                    })
                  }
                >
                  {(provider?.credentialModes ?? []).map((mode) => (
                    <option key={mode} value={mode}>
                      {mode}
                    </option>
                  ))}
                </select>
              </label>
              {choice.mode === 'PLATFORM_CREDITS' ? (
                <>
                  <label>
                    Teto de cobrança
                    <input
                      inputMode="numeric"
                      required
                      aria-describedby="workspace-cost-quote"
                      pattern="[1-9][0-9]{0,12}"
                      disabled={jobActive || !costEstimate}
                      value={choice.maximumCostMinor}
                      onChange={(e) =>
                        setChoice({ ...choice, maximumCostMinor: e.target.value, consent: false })
                      }
                    />
                  </label>
                  <label className="prompt-consent">
                    <input
                      type="checkbox"
                      required
                      aria-describedby="workspace-cost-quote"
                      disabled={jobActive || !costEstimate}
                      checked={choice.consent}
                      onChange={(e) => setChoice({ ...choice, consent: e.target.checked })}
                    />
                    Autorizo cobrança real até o teto informado para esta versão e operação.
                  </label>
                </>
              ) : (
                <label>
                  Conexão
                  <select
                    value={choice.connectionId ?? ''}
                    required
                    disabled={jobActive}
                    onChange={(e) => setChoice({ ...choice, connectionId: e.target.value || null })}
                  >
                    <option value="">Selecione</option>
                    {availableConnections.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.displayLabel}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                Destino da adaptação
                <select
                  value={destination}
                  disabled={jobActive || quoteOperation !== 'ADAPT'}
                  onChange={(e) => setDestination(e.target.value as typeof destination)}
                >
                  {['codex', 'chatgpt', 'claude', 'gemini', 'cursor', 'lovable', 'bolt'].map(
                    (item) => (
                      <option key={item}>{item}</option>
                    ),
                  )}
                </select>
              </label>
            </div>
            <div
              id="workspace-cost-quote"
              className="prompt-cost-quote"
              role="status"
              aria-live="polite"
            >
              {costEstimateBusy ? <p>Calculando cotação da versão selecionada…</p> : null}
              {costEstimate ? (
                <>
                  <p>
                    Cotação da versão {version.sequence} para {costEstimate.operation}
                    {costEstimate.operation === 'ADAPT' ? ` (${destination})` : ''}: máximo de{' '}
                    {costEstimate.maximumCostMinor} unidades mínimas. Entrada máxima:{' '}
                    {costEstimate.maximumInputTokens.toLocaleString('pt-BR')} tokens; saída máxima:{' '}
                    {costEstimate.maximumOutputTokens.toLocaleString('pt-BR')} tokens.
                  </p>
                  <p>
                    Catálogo {costEstimate.pricingVersion}; cotação gerada em{' '}
                    {new Date(costEstimate.quotedAt).toLocaleString('pt-BR')}.
                  </p>
                  <p>
                    Seções enviadas: {costEstimate.reportSections.map(sectionLabel).join(', ')}.
                  </p>
                  <p>{costEstimate.retentionNotice}</p>
                </>
              ) : null}
              {costEstimateError ? (
                <p role="alert" className="field-error">
                  {costEstimateError}
                </p>
              ) : null}
            </div>
            <div className="prompt-actions">
              <button
                type="button"
                disabled={jobActive || quoteOperation !== 'ADAPT' || !costEstimate}
                onClick={() => void run('adapt')}
              >
                Adaptar
              </button>
              {provider?.previewEligible ? (
                <button
                  type="button"
                  disabled={jobActive || quoteOperation !== 'PREVIEW' || !costEstimate}
                  onClick={() => void run('preview')}
                >
                  Gerar prévia
                </button>
              ) : null}
              {trackingInterrupted ? (
                <button type="button" onClick={() => void resumeTracking()}>
                  {activeJob?.status === 'SUCCEEDED'
                    ? 'Retomar resultado concluído'
                    : 'Retomar acompanhamento'}
                </button>
              ) : null}
              {activeJob &&
              !['SUCCEEDED', 'FAILED', 'CANCELLED', 'AMBIGUOUS'].includes(activeJob.status) ? (
                <>
                  <button type="button" onClick={() => void cancel()}>
                    Cancelar
                  </button>
                </>
              ) : null}
            </div>
          </section>
        ) : null}
        {preview ? (
          <section aria-labelledby="preview-heading">
            <h2 id="preview-heading">Prévia</h2>
            <p className="preview-content">{preview.content}</p>
            <p>{preview.summary}</p>
          </section>
        ) : null}
      </main>
    </div>
  );
}

function validChoice(choice: ExecutionChoice, quotedMaximumCostMinor: string): boolean {
  if (!choice.model) return false;
  return choice.mode === 'PLATFORM_CREDITS'
    ? choice.consent &&
        /^[1-9][0-9]{0,12}$/.test(choice.maximumCostMinor) &&
        BigInt(choice.maximumCostMinor) >= BigInt(quotedMaximumCostMinor)
    : Boolean(choice.connectionId);
}

function versionQuoteFingerprint(
  versionId: string,
  provider: PublicProviderCapabilities['provider'],
  model: string,
  operation: 'ADAPT' | 'PREVIEW',
  destination: string,
): string {
  return JSON.stringify({
    versionId,
    provider,
    model,
    operation,
    destination: operation === 'ADAPT' ? destination : null,
  });
}

function isAmbiguousMutationFailure(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? Reflect.get(error, 'code')
      : null;
  return ['NETWORK_ERROR', 'INVALID_RESPONSE', 'HTTP_ERROR', 'INTERNAL'].includes(String(code));
}

function sectionLabel(section: PromptVersionCostEstimate['reportSections'][number]): string {
  return {
    technologies: 'tecnologias',
    structure: 'estrutura',
    evidence: 'evidências',
    limitations: 'limitações',
    confidence: 'confiança',
  }[section];
}
