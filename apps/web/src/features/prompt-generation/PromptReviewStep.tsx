import type {
  AiConnection,
  CredentialMode,
  PromptCostEstimate,
  PromptWizardInput,
  PublicProviderCapabilities,
} from '@extractionstack/shared';
import type { RefObject } from 'react';

export type PromptExecutionSelection = Readonly<{
  provider: PublicProviderCapabilities['provider'];
  model: string;
  credentialMode: CredentialMode;
  connectionId: string | null;
  maximumCostMinor: string;
  acceptPlatformCharge: boolean;
}>;

export function PromptReviewStep({
  draft,
  providers,
  connections,
  selection,
  costEstimate,
  costEstimateBusy,
  costEstimateError,
  headingRef,
  onSelectionChange,
}: {
  draft: PromptWizardInput;
  providers: readonly PublicProviderCapabilities[];
  connections: readonly AiConnection[];
  selection: PromptExecutionSelection;
  costEstimate: PromptCostEstimate | null;
  costEstimateBusy: boolean;
  costEstimateError: string;
  headingRef?: RefObject<HTMLHeadingElement>;
  onSelectionChange: (next: PromptExecutionSelection) => void;
}): JSX.Element {
  const provider = providers.find((item) => item.provider === selection.provider);
  const modes = provider?.credentialModes ?? [];
  const availableConnections = connections.filter(
    (connection) =>
      connection.provider === selection.provider &&
      connection.state === 'ACTIVE' &&
      connection.credentialMode === selection.credentialMode,
  );
  const approximateTokens = Math.max(
    1,
    Math.ceil(
      [draft.objective, draft.audience, draft.freeInstructions, ...draft.requirements].join(' ')
        .length / 4,
    ),
  );

  return (
    <section className="prompt-review" aria-labelledby="prompt-review-heading">
      <h2 id="prompt-review-heading" ref={headingRef} tabIndex={-1}>
        Revise geração e uso de dados
      </h2>
      <dl className="prompt-review-list">
        <div>
          <dt>Objetivo</dt>
          <dd>{draft.objective}</dd>
        </div>
        <div>
          <dt>Instruções livres</dt>
          <dd>{draft.freeInstructions || 'Nenhuma instrução adicional.'}</dd>
        </div>
        <div>
          <dt>Idioma</dt>
          <dd>{draft.language}</dd>
        </div>
        <div>
          <dt>Nível de detalhe</dt>
          <dd>{draft.detail}</dd>
        </div>
        <div>
          <dt>Destino</dt>
          <dd>{draft.destination}</dd>
        </div>
        <div>
          <dt>Seções do relatório enviadas</dt>
          <dd>
            Tecnologias, estrutura, evidências, limitações e confiança — somente campos permitidos e
            limitados.
          </dd>
        </div>
        <div>
          <dt>Estimativa aproximada</dt>
          <dd>
            Cerca de {approximateTokens.toLocaleString('pt-BR')} tokens das suas instruções, antes
            do contexto seguro do relatório. Não é uma cobrança.
          </dd>
        </div>
        <div>
          <dt>Retenção</dt>
          <dd>
            Prompt, versões e prévia ficam no histórico do projeto. Credenciais e respostas brutas
            do provedor não são exibidas.
          </dd>
        </div>
      </dl>

      <div className="prompt-field-grid">
        <label>
          Provedor
          <select
            value={selection.provider}
            onChange={(event) => {
              const next = providers.find((item) => item.provider === event.target.value);
              if (!next) return;
              onSelectionChange({
                ...selection,
                provider: next.provider,
                model: next.models[0] ?? '',
                credentialMode: next.credentialModes[0],
                connectionId: null,
                acceptPlatformCharge: false,
              });
            }}
          >
            {providers.map((item) => (
              <option key={item.provider} value={item.provider}>
                {item.provider}
              </option>
            ))}
          </select>
        </label>
        <label>
          Modelo
          <select
            value={selection.model}
            onChange={(event) => onSelectionChange({ ...selection, model: event.target.value })}
          >
            {(provider?.models ?? []).map((model) => (
              <option key={model}>{model}</option>
            ))}
          </select>
        </label>
        <label>
          Modo de conexão
          <select
            value={selection.credentialMode}
            onChange={(event) =>
              onSelectionChange({
                ...selection,
                credentialMode: event.target.value as CredentialMode,
                connectionId: null,
                acceptPlatformCharge: false,
              })
            }
          >
            {modes.map((mode) => (
              <option key={mode} value={mode}>
                {mode === 'PLATFORM_CREDITS'
                  ? 'Créditos da plataforma'
                  : mode === 'API_KEY'
                    ? 'Chave própria'
                    : 'OAuth'}
              </option>
            ))}
          </select>
        </label>
        {selection.credentialMode !== 'PLATFORM_CREDITS' ? (
          <label>
            Conexão
            <select
              required
              value={selection.connectionId ?? ''}
              onChange={(event) =>
                onSelectionChange({ ...selection, connectionId: event.target.value || null })
              }
            >
              <option value="">Selecione</option>
              {availableConnections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.displayLabel}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <>
            <div
              id="wizard-cost-quote"
              className="prompt-cost-quote"
              role="status"
              aria-live="polite"
            >
              {costEstimateBusy ? <p>Calculando cotação segura…</p> : null}
              {costEstimate ? (
                <>
                  <p>
                    Estimativa máxima para este relatório: {costEstimate.maximumCostMinor} unidades
                    mínimas. Entrada máxima:{' '}
                    {costEstimate.maximumInputTokens.toLocaleString('pt-BR')} tokens; saída máxima:{' '}
                    {costEstimate.maximumOutputTokens.toLocaleString('pt-BR')} tokens.
                  </p>
                  <p>
                    Catálogo {costEstimate.pricingVersion}; cotação gerada em{' '}
                    {new Date(costEstimate.quotedAt).toLocaleString('pt-BR')}.
                  </p>
                </>
              ) : null}
              {costEstimateError ? (
                <p role="alert" className="field-error">
                  {costEstimateError}
                </p>
              ) : null}
            </div>
            <label>
              Teto de cobrança (unidades mínimas)
              <input
                required
                aria-describedby="wizard-cost-quote"
                disabled={!costEstimate}
                inputMode="numeric"
                pattern="[1-9][0-9]{0,12}"
                value={selection.maximumCostMinor}
                onChange={(event) =>
                  onSelectionChange({
                    ...selection,
                    maximumCostMinor: event.target.value,
                    acceptPlatformCharge: false,
                  })
                }
              />
            </label>
            <label className="prompt-consent">
              <input
                type="checkbox"
                required
                aria-describedby="wizard-cost-quote"
                disabled={!costEstimate}
                checked={selection.acceptPlatformCharge}
                onChange={(event) =>
                  onSelectionChange({ ...selection, acceptPlatformCharge: event.target.checked })
                }
              />
              Autorizo a cobrança real até o teto informado. A cobrança respeitará esse teto mesmo
              que a estimativa aproximada de tokens varie.
            </label>
          </>
        )}
      </div>
    </section>
  );
}
