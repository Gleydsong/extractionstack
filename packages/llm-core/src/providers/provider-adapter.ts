import {
  CredentialModeSchema,
  LlmProviderSchema,
  PromptPreviewSchema,
  PromptVersionSchema,
  PromptWizardInputSchema,
  ProviderAuthorizationSchema,
  PublicIsoDateTimeSchema,
  type CredentialMode,
  type LlmProvider,
} from '@extractionstack/shared';
import { z } from 'zod';
import { ProviderRequestIdSchema } from './provider-errors';

export { ProviderRequestIdSchema } from './provider-errors';

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
  previewEligible: boolean;
  enabled: boolean;
  circuitBreakerOpen: boolean;
}>;

const NaturalLanguageContentSchema = z.string().trim().min(1).max(100_000);
const PreviewContentSchema = z.string().trim().min(1).max(50_000);
const PreviewSummarySchema = z.string().trim().min(1).max(2_000);
export const ResolvedProviderCredentialSchema = z
  .object({
    mode: CredentialModeSchema,
    value: z.string().min(1).max(16_384),
  })
  .strict()
  .readonly();
export type ResolvedProviderCredential = z.infer<typeof ResolvedProviderCredentialSchema>;

function validateProviderCredential(
  value: Readonly<{ provider: LlmProvider; credential: ResolvedProviderCredential }>,
  context: z.RefinementCtx,
): void {
  const result = ProviderAuthorizationSchema.safeParse({
    provider: value.provider,
    credentialMode: value.credential.mode,
  });

  if (!result.success) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['credential', 'mode'],
      message: 'Credential mode is not supported by provider',
    });
  }
}

export const ValidateConnectionInputSchema = z
  .object({
    provider: LlmProviderSchema,
    credential: ResolvedProviderCredentialSchema,
  })
  .strict()
  .superRefine(validateProviderCredential)
  .readonly();
export type ValidateConnectionInput = z.infer<typeof ValidateConnectionInputSchema>;

export const ConnectionValidationSchema = z
  .object({
    valid: z.boolean(),
    expiresAt: PublicIsoDateTimeSchema.nullable(),
    scopes: z.array(z.string().trim().min(1).max(160)).max(30).readonly(),
  })
  .strict()
  .readonly();
export type ConnectionValidation = z.infer<typeof ConnectionValidationSchema>;

export const PromptLayerSchema = z
  .object({
    kind: z.enum([
      'platform-policy',
      'task',
      'user-instructions',
      'source-context',
      'destination-rules',
      'response-contract',
    ]),
    content: NaturalLanguageContentSchema,
  })
  .strict()
  .readonly();
export type PromptLayer = z.infer<typeof PromptLayerSchema>;

export const GenerationInputSchema = z
  .object({
    provider: LlmProviderSchema,
    model: z.string().trim().min(1).max(128),
    credential: ResolvedProviderCredentialSchema,
    wizardInput: PromptWizardInputSchema,
    sourcePrompt: PromptVersionSchema.nullable(),
    layers: z.array(PromptLayerSchema).min(1).max(6).readonly(),
    maxOutputTokens: z.number().int().positive().max(1_000_000),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .strict()
  .superRefine(validateProviderCredential)
  .readonly();
export type GenerationInput = z.infer<typeof GenerationInputSchema>;

export const PreviewInputSchema = z
  .object({
    generation: GenerationInputSchema,
    preview: PromptPreviewSchema,
  })
  .strict()
  .readonly();
export type PreviewInput = z.infer<typeof PreviewInputSchema>;

export const NormalizedUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative(),
    estimatedCostMicros: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .superRefine(({ inputTokens, outputTokens, totalTokens }, context) => {
    if (totalTokens !== inputTokens + outputTokens) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['totalTokens'],
        message: 'Total tokens must equal input plus output tokens',
      });
    }
  })
  .readonly();
export type NormalizedUsage = z.infer<typeof NormalizedUsageSchema>;

export const UsageEstimateSchema = z
  .object({
    usage: NormalizedUsageSchema,
    pricingMetadataVersion: z.string().trim().min(1).max(64),
  })
  .strict()
  .readonly();
export type UsageEstimate = z.infer<typeof UsageEstimateSchema>;

export const NormalizedFinishReasonSchema = z.enum(['complete', 'length', 'blocked']);

export const NormalizedGenerationSchema = z
  .object({
    content: NaturalLanguageContentSchema,
    finishReason: NormalizedFinishReasonSchema,
    providerRequestId: ProviderRequestIdSchema,
    usage: NormalizedUsageSchema,
  })
  .strict()
  .readonly();
export type NormalizedGeneration = z.infer<typeof NormalizedGenerationSchema>;

export const NormalizedPreviewSchema = z
  .object({
    content: PreviewContentSchema,
    summary: PreviewSummarySchema,
    finishReason: NormalizedFinishReasonSchema,
    providerRequestId: ProviderRequestIdSchema,
    usage: NormalizedUsageSchema,
  })
  .strict()
  .readonly();
export type NormalizedPreview = z.infer<typeof NormalizedPreviewSchema>;

export const parseValidateConnectionInput = (input: unknown): ValidateConnectionInput =>
  ValidateConnectionInputSchema.parse(input);
export const parseConnectionValidation = (input: unknown): ConnectionValidation =>
  ConnectionValidationSchema.parse(input);
export const parseGenerationInput = (input: unknown): GenerationInput =>
  GenerationInputSchema.parse(input);
export const parsePreviewInput = (input: unknown): PreviewInput => PreviewInputSchema.parse(input);
export const parseNormalizedUsage = (input: unknown): NormalizedUsage =>
  NormalizedUsageSchema.parse(input);
export const parseUsageEstimate = (input: unknown): UsageEstimate =>
  UsageEstimateSchema.parse(input);
export const parseNormalizedGeneration = (input: unknown): NormalizedGeneration =>
  NormalizedGenerationSchema.parse(input);
export const parseNormalizedPreview = (input: unknown): NormalizedPreview =>
  NormalizedPreviewSchema.parse(input);

export interface LlmProviderAdapter {
  readonly provider: LlmProvider;
  getCapabilities(): ProviderCapabilities;
  validateConnection(input: ValidateConnectionInput): Promise<ConnectionValidation>;
  estimateUsage(input: GenerationInput): Promise<UsageEstimate>;
  generatePrompt(input: GenerationInput): Promise<NormalizedGeneration>;
  generatePreview(input: PreviewInput): Promise<NormalizedPreview>;
  cancel?(providerRequestId: string): Promise<void>;
}
