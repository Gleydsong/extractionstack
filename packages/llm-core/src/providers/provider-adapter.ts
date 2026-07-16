import type {
  CredentialMode,
  LlmProvider,
  PromptPreview,
  PromptVersion,
  PromptWizardInput,
} from '@extractionstack/shared';

export type ProviderCapabilities = Readonly<{
  provider: LlmProvider;
  credentialModes: readonly CredentialMode[];
  models: readonly string[];
  contextWindowTokens: number;
  maxOutputTokens: number;
  supportsStructuredOutput: boolean;
  supportsCancellation: boolean;
  supportsCredentialRefresh: boolean;
  oauthScopes: readonly string[];
  previewEligible: boolean;
  pricingMetadataVersion: string;
  enabled: boolean;
  circuitBreakerOpen: boolean;
}>;

export type PublicProviderCapabilities = Readonly<{
  provider: LlmProvider;
  credentialModes: readonly CredentialMode[];
  models: readonly string[];
  contextWindowTokens: number;
  maxOutputTokens: number;
  supportsStructuredOutput: boolean;
  supportsCancellation: boolean;
  supportsCredentialRefresh: boolean;
  oauthScopes: readonly string[];
  previewEligible: boolean;
  enabled: boolean;
  circuitBreakerOpen: boolean;
}>;

export type ResolvedProviderCredential = Readonly<{
  mode: CredentialMode;
  value: string;
}>;

export type ValidateConnectionInput = Readonly<{
  provider: LlmProvider;
  credential: ResolvedProviderCredential;
}>;

export type ConnectionValidation = Readonly<{
  valid: boolean;
  expiresAt: string | null;
  scopes: readonly string[];
}>;

export type PromptLayer = Readonly<{
  kind:
    | 'platform-policy'
    | 'task'
    | 'user-instructions'
    | 'source-context'
    | 'destination-rules'
    | 'response-contract';
  content: string;
}>;

export type GenerationInput = Readonly<{
  provider: LlmProvider;
  model: string;
  credential: ResolvedProviderCredential;
  wizardInput: PromptWizardInput;
  sourcePrompt: PromptVersion | null;
  layers: readonly PromptLayer[];
  maxOutputTokens: number;
}>;

export type PreviewInput = Readonly<{
  generation: GenerationInput;
  preview: PromptPreview;
}>;

export type NormalizedUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostMicros: number | null;
}>;

export type UsageEstimate = Readonly<{
  usage: NormalizedUsage;
  pricingMetadataVersion: string;
}>;

export type NormalizedGeneration = Readonly<{
  content: string;
  finishReason: 'complete' | 'length' | 'blocked';
  providerRequestId: string | null;
  usage: NormalizedUsage;
}>;

export type NormalizedPreview = Readonly<{
  content: string;
  summary: string;
  finishReason: 'complete' | 'length' | 'blocked';
  providerRequestId: string | null;
  usage: NormalizedUsage;
}>;

export interface LlmProviderAdapter {
  readonly provider: LlmProvider;
  getCapabilities(): ProviderCapabilities;
  validateConnection(input: ValidateConnectionInput): Promise<ConnectionValidation>;
  estimateUsage(input: GenerationInput): Promise<UsageEstimate>;
  generatePrompt(input: GenerationInput): Promise<NormalizedGeneration>;
  generatePreview(input: PreviewInput): Promise<NormalizedPreview>;
  cancel?(providerRequestId: string): Promise<void>;
}
