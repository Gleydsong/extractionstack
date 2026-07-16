import type { LlmProvider } from '@extractionstack/shared';
import { z } from 'zod';
import type { ProviderCapabilities, PublicProviderCapabilities } from './provider-adapter';
import { ProviderFailure } from './provider-errors';

const CapabilityBaseShape = {
  models: z.array(z.string().trim().min(1).max(128)).min(1),
  contextWindowTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  supportsStructuredOutput: z.boolean(),
  supportsCancellation: z.boolean(),
  supportsCredentialRefresh: z.boolean(),
  oauthScopes: z.array(z.string().trim().min(1).max(160)).max(30),
  previewEligible: z.boolean(),
  pricingMetadataVersion: z.string().trim().min(1).max(64),
  enabled: z.boolean(),
  circuitBreakerOpen: z.boolean(),
} as const;

const ProviderCapabilitiesSchema = z.discriminatedUnion('provider', [
  z
    .object({
      provider: z.literal('FAKE'),
      credentialModes: z.tuple([z.literal('PLATFORM_CREDITS')]),
      ...CapabilityBaseShape,
    })
    .strict(),
  z
    .object({
      provider: z.literal('OPENAI'),
      credentialModes: z.tuple([z.literal('API_KEY'), z.literal('PLATFORM_CREDITS')]),
      ...CapabilityBaseShape,
    })
    .strict(),
  z
    .object({
      provider: z.literal('GEMINI'),
      credentialModes: z.tuple([
        z.literal('OAUTH'),
        z.literal('API_KEY'),
        z.literal('PLATFORM_CREDITS'),
      ]),
      ...CapabilityBaseShape,
    })
    .strict(),
]);

function freezeCapabilities(
  capabilities: z.infer<typeof ProviderCapabilitiesSchema>,
): ProviderCapabilities {
  return Object.freeze({
    ...capabilities,
    credentialModes: Object.freeze([...capabilities.credentialModes]),
    models: Object.freeze([...capabilities.models]),
    oauthScopes: Object.freeze([...capabilities.oauthScopes]),
  });
}

export class ProviderRegistry {
  private readonly capabilitiesByProvider: ReadonlyMap<LlmProvider, ProviderCapabilities>;

  constructor(configuredCapabilities: readonly unknown[]) {
    const capabilitiesByProvider = new Map<LlmProvider, ProviderCapabilities>();

    for (const input of configuredCapabilities) {
      const result = ProviderCapabilitiesSchema.safeParse(input);

      if (!result.success) {
        throw new ProviderFailure('INPUT_INVALID', { cause: result.error });
      }

      const capabilities = freezeCapabilities(result.data);

      if (capabilitiesByProvider.has(capabilities.provider)) {
        throw new ProviderFailure('INPUT_INVALID');
      }

      capabilitiesByProvider.set(capabilities.provider, capabilities);
    }

    this.capabilitiesByProvider = capabilitiesByProvider;
  }

  get(provider: LlmProvider): ProviderCapabilities {
    const capabilities = this.capabilitiesByProvider.get(provider);

    if (!capabilities) {
      throw new ProviderFailure('PROVIDER_NOT_CONFIGURED');
    }

    return capabilities;
  }

  assertModel(provider: LlmProvider, model: string): string {
    const capabilities = this.get(provider);

    if (!capabilities.models.includes(model)) {
      throw new ProviderFailure('MODEL_UNAVAILABLE');
    }

    return model;
  }

  listPublic(): readonly PublicProviderCapabilities[] {
    return Object.freeze(
      [...this.capabilitiesByProvider.values()].map((capabilities) => {
        return Object.freeze({
          provider: capabilities.provider,
          credentialModes: capabilities.credentialModes,
          models: capabilities.models,
          contextWindowTokens: capabilities.contextWindowTokens,
          maxOutputTokens: capabilities.maxOutputTokens,
          supportsStructuredOutput: capabilities.supportsStructuredOutput,
          supportsCancellation: capabilities.supportsCancellation,
          supportsCredentialRefresh: capabilities.supportsCredentialRefresh,
          oauthScopes: capabilities.oauthScopes,
          previewEligible: capabilities.previewEligible,
          enabled: capabilities.enabled,
          circuitBreakerOpen: capabilities.circuitBreakerOpen,
        });
      }),
    );
  }
}
