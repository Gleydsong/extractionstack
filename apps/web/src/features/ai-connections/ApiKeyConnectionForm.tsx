import { useEffect, useState, type FormEvent } from 'react';
import type { LlmProvider } from '@extractionstack/shared';
import type { ApiKeyCommand, PublicProviderCapabilities } from './useAiConnectionsApi';

type ApiKeyProvider = Extract<LlmProvider, 'OPENAI' | 'GEMINI'>;

const PROVIDER_LABELS: Record<ApiKeyProvider, string> = {
  OPENAI: 'OpenAI',
  GEMINI: 'Gemini',
};

interface ApiKeyConnectionFormProps {
  providers: readonly PublicProviderCapabilities[];
  isSubmitting: boolean;
  onSubmit(command: ApiKeyCommand): Promise<void>;
}

export function ApiKeyConnectionForm({
  providers,
  isSubmitting,
  onSubmit,
}: ApiKeyConnectionFormProps): JSX.Element | null {
  const availableProviders = providers.filter(
    (provider): provider is PublicProviderCapabilities & { provider: ApiKeyProvider } =>
      (provider.provider === 'OPENAI' || provider.provider === 'GEMINI') &&
      provider.enabled &&
      !provider.circuitBreakerOpen &&
      provider.credentialModes.includes('API_KEY'),
  );
  const [provider, setProvider] = useState<ApiKeyProvider>(
    availableProviders[0]?.provider ?? 'OPENAI',
  );
  const [displayLabel, setDisplayLabel] = useState('OpenAI principal');
  const [apiKey, setApiKey] = useState('');

  useEffect(() => {
    if (!availableProviders.some((capability) => capability.provider === provider)) {
      const nextProvider = availableProviders[0]?.provider;
      if (nextProvider) {
        setProvider(nextProvider);
        setDisplayLabel(`${PROVIDER_LABELS[nextProvider]} principal`);
      }
    }
  }, [availableProviders, provider]);

  if (availableProviders.length === 0) return null;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (apiKey.length < 8 || !displayLabel.trim()) return;

    try {
      await onSubmit({ provider, displayLabel: displayLabel.trim(), apiKey });
    } finally {
      setApiKey('');
    }
  }

  return (
    <form className="connection-form" onSubmit={(event) => void submit(event)}>
      <div className="form-field">
        <label htmlFor="provider-api-key-provider">Provedor</label>
        <select
          id="provider-api-key-provider"
          value={provider}
          onChange={(event) => {
            const nextProvider = event.target.value as ApiKeyProvider;
            setProvider(nextProvider);
            setDisplayLabel(`${PROVIDER_LABELS[nextProvider]} principal`);
          }}
          disabled={isSubmitting}
        >
          {availableProviders.map((capability) => (
            <option key={capability.provider} value={capability.provider}>
              {PROVIDER_LABELS[capability.provider]}
            </option>
          ))}
        </select>
      </div>

      <div className="form-field">
        <label htmlFor="provider-api-key-label">Nome da conexão</label>
        <input
          id="provider-api-key-label"
          type="text"
          autoComplete="off"
          maxLength={120}
          value={displayLabel}
          onChange={(event) => setDisplayLabel(event.target.value)}
          disabled={isSubmitting}
          required
        />
      </div>

      <div className="form-field">
        <label htmlFor="provider-api-key">Chave de API</label>
        <input
          id="provider-api-key"
          type="password"
          autoComplete="off"
          minLength={8}
          maxLength={16_384}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          disabled={isSubmitting}
          aria-describedby="provider-api-key-help"
          required
        />
        <p id="provider-api-key-help" className="field-help">
          A chave é enviada uma vez para validação e não volta a ser exibida.
        </p>
      </div>

      <button className="primary-action" type="submit" disabled={isSubmitting || apiKey.length < 8}>
        {isSubmitting ? 'Validando…' : 'Conectar'}
      </button>
    </form>
  );
}
