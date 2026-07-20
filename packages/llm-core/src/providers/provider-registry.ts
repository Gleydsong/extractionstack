import {
  PublicProviderCapabilitiesSchema,
  type LlmProvider,
  type PublicProviderCapabilities,
} from '@extractionstack/shared';
import { z } from 'zod';
import type { ProviderCapabilities } from './provider-adapter';
import { ProviderFailure } from './provider-errors';

const ProviderRegistryOptionsSchema = z
  .object({
    allowTestProvider: z.boolean().optional(),
  })
  .strict();

export type ProviderRegistryOptions = Readonly<{
  allowTestProvider?: boolean;
}>;

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
      credentialModes: z.union([
        z.tuple([z.literal('API_KEY'), z.literal('PLATFORM_CREDITS')]),
        z.tuple([z.literal('OAUTH'), z.literal('API_KEY'), z.literal('PLATFORM_CREDITS')]),
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
  private readonly allowTestProvider: boolean;

  constructor(configuredCapabilities: readonly unknown[], options: ProviderRegistryOptions = {}) {
    const optionsResult = ProviderRegistryOptionsSchema.safeParse(options);

    if (!optionsResult.success) {
      throw new ProviderFailure('INPUT_INVALID');
    }

    this.allowTestProvider = optionsResult.data.allowTestProvider ?? false;
    const capabilitiesByProvider = new Map<LlmProvider, ProviderCapabilities>();

    for (const input of configuredCapabilities) {
      const result = ProviderCapabilitiesSchema.safeParse(input);

      if (!result.success) {
        throw new ProviderFailure('INPUT_INVALID');
      }

      const capabilities = freezeCapabilities(result.data);

      if (capabilities.provider === 'FAKE' && capabilities.enabled && !this.allowTestProvider) {
        throw new ProviderFailure('INPUT_INVALID');
      }

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
      [...this.capabilitiesByProvider.values()]
        .filter((capabilities) => capabilities.provider !== 'FAKE' || this.allowTestProvider)
        .map((capabilities) => {
          return PublicProviderCapabilitiesSchema.parse({
            provider: capabilities.provider,
            credentialModes: capabilities.credentialModes,
            models: capabilities.models,
            contextWindowTokens: capabilities.contextWindowTokens,
            maxOutputTokens: capabilities.maxOutputTokens,
            supportsStructuredOutput: capabilities.supportsStructuredOutput,
            supportsCancellation: capabilities.supportsCancellation,
            supportsCredentialRefresh: capabilities.supportsCredentialRefresh,
            previewEligible: capabilities.previewEligible,
            enabled: capabilities.enabled,
            circuitBreakerOpen: capabilities.circuitBreakerOpen,
          });
        }),
    );
  }
}
