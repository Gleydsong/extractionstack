import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  AiConnection,
  PromptCostEstimate,
  PromptGenerationRequest,
  PromptWizardInput,
  PublicProviderCapabilities,
} from '@extractionstack/shared';
import { Header } from '../auth/Header';
import { PromptReviewStep, type PromptExecutionSelection } from './PromptReviewStep';
import { initialPromptWizardState, promptWizardReducer } from './prompt-wizard-state';
import {
  pollPromptJob,
  PromptClientError,
  promptErrorMessage,
  stableIdempotencyKey,
  usePromptApi,
  type PromptApi,
} from './usePromptApi';

export function PromptWizardPage({ api: injected }: { api?: PromptApi }): JSX.Element {
  const { id = '' } = useParams();
  const api = usePromptApi(injected);
  const navigate = useNavigate();
  const [state, dispatch] = useReducer(promptWizardReducer, id, initialPromptWizardState);
  const [providers, setProviders] = useState<readonly PublicProviderCapabilities[]>([]);
  const [connections, setConnections] = useState<AiConnection[]>([]);
  const [selection, setSelection] = useState<PromptExecutionSelection>({
    provider: 'OPENAI',
    model: '',
    credentialMode: 'PLATFORM_CREDITS',
    connectionId: null,
    maximumCostMinor: '',
    acceptPlatformCharge: false,
  });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [costEstimate, setCostEstimate] = useState<PromptCostEstimate | null>(null);
  const [costEstimateBusy, setCostEstimateBusy] = useState(false);
  const [costEstimateError, setCostEstimateError] = useState('');
  const quoteFingerprint = useRef<string | null>(null);
  const attempts = useRef<{
    project?: Readonly<{ fingerprint: string; key: string }>;
    generation?: Readonly<{ fingerprint: string; key: string }>;
    createdProject?: Readonly<{ fingerprint: string; id: string }>;
  }>({});
  const pollController = useRef<AbortController | null>(null);
  const intentHeading = useRef<HTMLHeadingElement | null>(null);
  const requirementsHeading = useRef<HTMLHeadingElement | null>(null);
  const reviewHeading = useRef<HTMLHeadingElement | null>(null);
  const objectiveInput = useRef<HTMLTextAreaElement | null>(null);
  const audienceInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => () => pollController.current?.abort(), []);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([api.listProviders(controller.signal), api.listConnections(controller.signal)])
      .then(([providerList, connectionList]) => {
        const available = providerList.filter((item) => item.enabled && !item.circuitBreakerOpen);
        setProviders(available);
        setConnections(connectionList);
        const first = available[0];
        if (first)
          setSelection((current) => ({
            ...current,
            provider: first.provider,
            model: first.models[0] ?? '',
            credentialMode: first.credentialModes.some((mode) => mode === current.credentialMode)
              ? current.credentialMode
              : first.credentialModes[0],
          }));
      })
      .catch((cause) => {
        if (!(cause instanceof DOMException && cause.name === 'AbortError'))
          setError(promptErrorMessage(cause));
      });
    return () => controller.abort();
  }, [api]);

  useEffect(() => {
    const heading =
      state.step === 'intent'
        ? intentHeading.current
        : state.step === 'requirements'
          ? requirementsHeading.current
          : reviewHeading.current;
    heading?.focus();
  }, [state.step]);

  useEffect(() => {
    if (state.errors.objective) objectiveInput.current?.focus();
    else if (state.errors.audience) audienceInput.current?.focus();
  }, [state.errors]);

  useEffect(() => {
    if (
      state.step !== 'review' ||
      selection.credentialMode !== 'PLATFORM_CREDITS' ||
      !selection.model
    ) {
      quoteFingerprint.current = null;
      setCostEstimate(null);
      setCostEstimateBusy(false);
      setCostEstimateError('');
      return;
    }
    const controller = new AbortController();
    const fingerprint = costQuoteFingerprint(state.draft, selection.provider, selection.model);
    quoteFingerprint.current = fingerprint;
    setCostEstimate(null);
    setCostEstimateBusy(true);
    setCostEstimateError('');
    void api
      .estimateCost(
        { wizard: state.draft, provider: selection.provider, model: selection.model },
        controller.signal,
      )
      .then((estimate) => {
        if (controller.signal.aborted || quoteFingerprint.current !== fingerprint) return;
        setCostEstimate(estimate);
        setSelection((current) =>
          current.provider === estimate.provider && current.model === estimate.model
            ? {
                ...current,
                maximumCostMinor: estimate.maximumCostMinor,
                acceptPlatformCharge: false,
              }
            : current,
        );
      })
      .catch((cause) => {
        if (
          quoteFingerprint.current === fingerprint &&
          !(cause instanceof DOMException && cause.name === 'AbortError')
        ) {
          setCostEstimateError(promptErrorMessage(cause));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setCostEstimateBusy(false);
      });
    return () => controller.abort();
  }, [api, selection.credentialMode, selection.model, selection.provider, state.draft, state.step]);

  const stringFields = useMemo(
    () => ({
      technologies: state.draft.technologies.join(', '),
      exclusions: state.draft.exclusions.join(', '),
      requirements: state.draft.requirements.join('\n'),
    }),
    [state.draft],
  );

  async function generate(): Promise<void> {
    if (
      !selection.model ||
      (selection.credentialMode !== 'PLATFORM_CREDITS' && !selection.connectionId)
    ) {
      setError('Selecione um modelo e uma conexão disponível.');
      return;
    }
    if (
      selection.credentialMode === 'PLATFORM_CREDITS' &&
      (!costEstimate ||
        quoteFingerprint.current !==
          costQuoteFingerprint(state.draft, selection.provider, selection.model) ||
        !selection.acceptPlatformCharge ||
        !/^[1-9][0-9]{0,12}$/.test(selection.maximumCostMinor) ||
        BigInt(selection.maximumCostMinor) < BigInt(costEstimate.maximumCostMinor))
    ) {
      setError('Informe o teto e autorize a cobrança para usar créditos da plataforma.');
      return;
    }
    setBusy(true);
    setError('');
    setStatus('Criando projeto e preparando geração…');
    pollController.current?.abort();
    const controller = new AbortController();
    pollController.current = controller;
    const projectFingerprint = JSON.stringify(state.draft);
    if (attempts.current.createdProject?.fingerprint !== projectFingerprint) {
      attempts.current.createdProject = undefined;
      attempts.current.project = undefined;
      attempts.current.generation = undefined;
    }
    let phase: 'project' | 'generation' | 'polling' = 'project';
    try {
      let projectId = attempts.current.createdProject?.id;
      if (!projectId) {
        const projectAttempt = mutationAttempt(
          attempts.current.project,
          projectFingerprint,
          'prompt-project',
        );
        attempts.current.project = projectAttempt;
        const project = await api.createProject(state.draft, projectAttempt.key);
        projectId = project.id;
        attempts.current.createdProject = { fingerprint: projectFingerprint, id: projectId };
        attempts.current.project = undefined;
      }
      const generationInput: PromptGenerationRequest = {
        provider: selection.provider,
        model: selection.model,
        credentialMode: selection.credentialMode,
        connectionId:
          selection.credentialMode === 'PLATFORM_CREDITS' ? null : selection.connectionId,
        acceptPlatformCharge:
          selection.credentialMode === 'PLATFORM_CREDITS' && selection.acceptPlatformCharge,
        maximumCostMinor:
          selection.credentialMode === 'PLATFORM_CREDITS' ? selection.maximumCostMinor : null,
      };
      const generationFingerprint = JSON.stringify({ projectId, ...generationInput });
      const generationAttempt = mutationAttempt(
        attempts.current.generation,
        generationFingerprint,
        'prompt-generation',
      );
      attempts.current.generation = generationAttempt;
      phase = 'generation';
      const job = await api.generate(projectId, generationInput, generationAttempt.key);
      phase = 'polling';
      const terminal = await pollPromptJob(api, job.id, controller.signal, (next) =>
        setStatus(next.message),
      );
      if (terminal.status !== 'SUCCEEDED') {
        attempts.current.generation = undefined;
        throw new PromptClientError('HTTP_ERROR');
      }
      attempts.current.generation = undefined;
      navigate(`/prompt-projects/${projectId}`);
    } catch (cause) {
      const aborted = cause instanceof DOMException && cause.name === 'AbortError';
      if (!aborted) {
        if (!isAmbiguousMutationFailure(cause)) {
          if (phase === 'project') attempts.current.project = undefined;
          else attempts.current.generation = undefined;
        }
        setError(promptErrorMessage(cause));
      }
      if (!controller.signal.aborted) setBusy(false);
    } finally {
      if (pollController.current === controller) pollController.current = null;
    }
  }

  return (
    <div className="app">
      <Header />
      <main className="prompt-page">
        <header className="page-heading">
          <p className="eyebrow">Nova criação</p>
          <h1>Transforme a extração em um prompt</h1>
          <p className="lead">
            Defina a intenção, acrescente instruções e revise exatamente quais dados e limites serão
            usados.
          </p>
        </header>
        {error ? (
          <p role="alert" className="connection-message error-text">
            {error}
          </p>
        ) : null}
        {status ? (
          <p role="status" aria-live="polite" className="connection-message">
            {status}
          </p>
        ) : null}
        {state.step === 'intent' ? (
          <section aria-labelledby="intent-heading">
            <h2 id="intent-heading" ref={intentHeading} tabIndex={-1}>
              1. Intenção
            </h2>
            <div className="prompt-field-grid">
              <label>
                Tipo de criação
                <select
                  value={state.draft.category}
                  onChange={(e) =>
                    dispatch({
                      type: 'set-field',
                      field: 'category',
                      value: e.target.value as never,
                    })
                  }
                >
                  {[
                    'application',
                    'landing_page',
                    'frontend',
                    'backend',
                    'api',
                    'design_system',
                    'documentation',
                    'tests',
                    'content',
                    'custom',
                  ].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Objetivo
                <textarea
                  ref={objectiveInput}
                  aria-invalid={Boolean(state.errors.objective)}
                  aria-describedby={state.errors.objective ? 'objective-error' : undefined}
                  value={state.draft.objective}
                  onChange={(e) =>
                    dispatch({ type: 'set-field', field: 'objective', value: e.target.value })
                  }
                />
              </label>
              {state.errors.objective ? (
                <p id="objective-error" className="field-error">
                  {state.errors.objective}
                </p>
              ) : null}
              <label>
                Público-alvo
                <input
                  ref={audienceInput}
                  aria-invalid={Boolean(state.errors.audience)}
                  aria-describedby={state.errors.audience ? 'audience-error' : undefined}
                  value={state.draft.audience}
                  onChange={(e) =>
                    dispatch({ type: 'set-field', field: 'audience', value: e.target.value })
                  }
                />
              </label>
              {state.errors.audience ? (
                <p id="audience-error" className="field-error">
                  {state.errors.audience}
                </p>
              ) : null}
            </div>
            <button
              className="primary-action"
              type="button"
              onClick={() => dispatch({ type: 'next' })}
            >
              Continuar
            </button>
          </section>
        ) : null}
        {state.step === 'requirements' ? (
          <section aria-labelledby="requirements-heading">
            <h2 id="requirements-heading" ref={requirementsHeading} tabIndex={-1}>
              2. Requisitos
            </h2>
            <div className="prompt-field-grid">
              <label>
                Idioma do prompt
                <select
                  value={state.draft.language}
                  onChange={(event) =>
                    dispatch({
                      type: 'set-field',
                      field: 'language',
                      value: event.target.value as typeof state.draft.language,
                    })
                  }
                >
                  <option value="pt-BR">Português (Brasil)</option>
                  <option value="en-US">English (US)</option>
                  <option value="es-ES">Español</option>
                </select>
              </label>
              <label>
                Nível de detalhe
                <select
                  value={state.draft.detail}
                  onChange={(event) =>
                    dispatch({
                      type: 'set-field',
                      field: 'detail',
                      value: event.target.value as typeof state.draft.detail,
                    })
                  }
                >
                  <option value="concise">Conciso</option>
                  <option value="balanced">Equilibrado</option>
                  <option value="complete">Completo</option>
                </select>
              </label>
              <p>
                <strong>Destino inicial:</strong> universal. Adaptações para ferramentas específicas
                são criadas depois, como novas versões.
              </p>
              <label>
                Tecnologias
                <input
                  value={stringFields.technologies}
                  onChange={(e) =>
                    dispatch({
                      type: 'set-field',
                      field: 'technologies',
                      value: split(e.target.value, ','),
                    })
                  }
                />
              </label>
              <label>
                Exclusões
                <input
                  value={stringFields.exclusions}
                  onChange={(e) =>
                    dispatch({
                      type: 'set-field',
                      field: 'exclusions',
                      value: split(e.target.value, ','),
                    })
                  }
                />
              </label>
              <label>
                Requisitos, um por linha
                <textarea
                  value={stringFields.requirements}
                  onChange={(e) =>
                    dispatch({
                      type: 'set-field',
                      field: 'requirements',
                      value: split(e.target.value, '\n'),
                    })
                  }
                />
              </label>
              <label>
                Instruções livres
                <textarea
                  value={state.draft.freeInstructions}
                  onChange={(e) =>
                    dispatch({
                      type: 'set-field',
                      field: 'freeInstructions',
                      value: e.target.value,
                    })
                  }
                />
              </label>
            </div>
            {Object.keys(state.errors).length ? (
              <p role="alert" className="field-error">
                Revise os campos indicados.
              </p>
            ) : null}
            <div className="prompt-actions">
              <button type="button" onClick={() => dispatch({ type: 'back' })}>
                Voltar
              </button>
              <button
                className="primary-action"
                type="button"
                onClick={() => dispatch({ type: 'review' })}
              >
                Revisar
              </button>
            </div>
          </section>
        ) : null}
        {state.step === 'review' ? (
          <>
            <PromptReviewStep
              draft={state.draft}
              providers={providers}
              connections={connections}
              selection={selection}
              costEstimate={costEstimate}
              costEstimateBusy={costEstimateBusy}
              costEstimateError={costEstimateError}
              onSelectionChange={setSelection}
              headingRef={reviewHeading}
            />
            <div className="prompt-actions">
              <button type="button" onClick={() => dispatch({ type: 'back' })}>
                Voltar
              </button>
              <button
                className="primary-action"
                type="button"
                disabled={busy}
                onClick={() => void generate()}
              >
                {busy ? 'Gerando…' : 'Gerar prompt'}
              </button>
            </div>
          </>
        ) : null}
      </main>
    </div>
  );
}

function split(value: string, separator: string): string[] {
  return value
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
}

function mutationAttempt(
  current: Readonly<{ fingerprint: string; key: string }> | undefined,
  fingerprint: string,
  prefix: string,
): Readonly<{ fingerprint: string; key: string }> {
  return current?.fingerprint === fingerprint
    ? current
    : { fingerprint, key: stableIdempotencyKey(prefix) };
}

function isAmbiguousMutationFailure(error: unknown): boolean {
  const code =
    error instanceof PromptClientError
      ? error.code
      : typeof error === 'object' && error !== null && 'code' in error
        ? Reflect.get(error, 'code')
        : null;
  return ['NETWORK_ERROR', 'INVALID_RESPONSE', 'HTTP_ERROR', 'INTERNAL'].includes(String(code));
}

function costQuoteFingerprint(
  draft: PromptWizardInput,
  provider: PublicProviderCapabilities['provider'],
  model: string,
): string {
  return JSON.stringify({ draft, provider, model });
}
