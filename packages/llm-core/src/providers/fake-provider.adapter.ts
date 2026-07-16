import { NormalizedUsageSchema } from './provider-adapter';
import type {
  ConnectionValidation,
  GenerationInput,
  LlmProviderAdapter,
  NormalizedGeneration,
  NormalizedPreview,
  NormalizedUsage,
  PreviewInput,
  ProviderCapabilities,
  UsageEstimate,
  ValidateConnectionInput,
} from './provider-adapter';
import {
  assertBoundedText,
  assertGenerationInput,
  assertValidationInput,
  estimateUsage,
  parseCapabilities,
  toPreview,
} from './provider-adapter-helpers';
import { ProviderFailure } from './provider-errors';

export type FakeProviderOptions = Readonly<{
  allowTestProvider?: boolean;
  capabilities?: ProviderCapabilities;
  content?: string;
  delayMs?: number;
  failure?: ProviderFailure;
  usage?: NormalizedUsage;
}>;

const DEFAULT_USAGE: NormalizedUsage = Object.freeze({
  inputTokens: 20,
  outputTokens: 10,
  totalTokens: 30,
  estimatedCostMicros: 0,
});

export class FakeProviderAdapter implements LlmProviderAdapter {
  readonly provider = 'FAKE' as const;
  private readonly content: string;
  private readonly delayMs: number;
  private readonly failure?: ProviderFailure;
  private readonly configuredUsage: NormalizedUsage;
  private readonly configuredCapabilities: ProviderCapabilities;

  constructor(options: FakeProviderOptions = {}) {
    if (options.allowTestProvider !== true) {
      throw new ProviderFailure('INPUT_INVALID');
    }
    if (!options.capabilities) {
      throw new ProviderFailure('INPUT_INVALID');
    }
    this.configuredCapabilities = parseCapabilities(
      options.capabilities,
      this.provider,
      ['PLATFORM_CREDITS'],
      false,
    );
    if (
      options.delayMs !== undefined &&
      (!Number.isInteger(options.delayMs) || options.delayMs < 0)
    ) {
      throw new ProviderFailure('INPUT_INVALID');
    }
    this.content = options.content ?? 'Prompt universal de teste.';
    this.delayMs = options.delayMs ?? 0;
    this.failure = options.failure;
    const configuredUsage = NormalizedUsageSchema.safeParse(options.usage ?? DEFAULT_USAGE);
    if (!configuredUsage.success) {
      throw new ProviderFailure('INPUT_INVALID');
    }
    this.configuredUsage = configuredUsage.data;
  }

  getCapabilities(): ProviderCapabilities {
    return this.configuredCapabilities;
  }

  async validateConnection(input: ValidateConnectionInput): Promise<ConnectionValidation> {
    assertValidationInput(this.provider, input);
    return Object.freeze({ valid: true, expiresAt: null, scopes: Object.freeze([]) });
  }

  async estimateUsage(input: GenerationInput): Promise<UsageEstimate> {
    assertGenerationInput(this.provider, input, this.configuredCapabilities);
    return estimateUsage(input, this.configuredCapabilities);
  }

  async generatePrompt(input: GenerationInput): Promise<NormalizedGeneration> {
    assertGenerationInput(this.provider, input, this.configuredCapabilities);
    if (this.delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
    }
    if (this.failure) throw this.failure;
    return Object.freeze({
      content: assertBoundedText(this.content, 100_000),
      finishReason: 'complete',
      providerRequestId: 'fake-request-1',
      usage: this.configuredUsage,
    });
  }

  async generatePreview(input: PreviewInput): Promise<NormalizedPreview> {
    const generation = await this.generatePrompt(input.generation);
    return toPreview(input, generation);
  }
}
