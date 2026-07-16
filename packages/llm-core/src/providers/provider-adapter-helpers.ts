import type { CredentialMode, LlmProvider } from '@extractionstack/shared';
import { z } from 'zod';
import {
  GenerationInputSchema,
  type GenerationInput,
  type NormalizedPreview,
  type NormalizedUsage,
  type PreviewInput,
  type ProviderCapabilities,
  type UsageEstimate,
  type ValidateConnectionInput,
} from './provider-adapter';
import { ProviderFailure, ProviderRequestIdSchema } from './provider-errors';

export type ProviderAdapterDependencies = Readonly<{
  fetch: typeof globalThis.fetch;
  baseUrl: URL;
  timeoutMs: number;
  maxOutputCharacters: number;
}>;

const DependenciesSchema = z
  .object({
    fetch: z.function(),
    baseUrl: z.instanceof(URL),
    timeoutMs: z.number().int().positive().max(300_000),
    maxOutputCharacters: z.number().int().positive().max(100_000),
  })
  .strict();

export type NormalizedFinishReason = 'complete' | 'length' | 'blocked';

export function parseDependencies(
  dependencies: ProviderAdapterDependencies,
): ProviderAdapterDependencies {
  const parsed = DependenciesSchema.safeParse(dependencies);
  if (!parsed.success) {
    throw new ProviderFailure('INPUT_INVALID');
  }
  const baseUrl = new URL(dependencies.baseUrl);
  if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname += '/';
  return Object.freeze({ ...dependencies, baseUrl });
}

export function assertGenerationInput(
  expectedProvider: LlmProvider,
  input: GenerationInput,
): GenerationInput {
  const parsed = GenerationInputSchema.safeParse(input);
  if (!parsed.success || parsed.data.provider !== expectedProvider) {
    throw new ProviderFailure('INPUT_INVALID');
  }
  return parsed.data;
}

export function assertValidationInput(
  expectedProvider: LlmProvider,
  input: ValidateConnectionInput,
): void {
  if (input.provider !== expectedProvider || !input.credential.value) {
    throw new ProviderFailure('INPUT_INVALID');
  }
}

export function capabilities(
  provider: LlmProvider,
  credentialModes: readonly CredentialMode[],
  supportsStructuredOutput: boolean,
): ProviderCapabilities {
  return Object.freeze({
    provider,
    credentialModes: Object.freeze([...credentialModes]),
    models: Object.freeze([]),
    contextWindowTokens: 1,
    maxOutputTokens: 1_000_000,
    supportsStructuredOutput,
    supportsCancellation: false,
    supportsCredentialRefresh: credentialModes.includes('OAUTH'),
    oauthScopes: Object.freeze([]),
    previewEligible: true,
    pricingMetadataVersion: 'unconfigured',
    enabled: true,
    circuitBreakerOpen: false,
  });
}

export function estimateUsage(input: GenerationInput): UsageEstimate {
  const inputCharacters = input.layers.reduce((total, layer) => total + layer.content.length, 0);
  const inputTokens = Math.ceil(inputCharacters / 4);
  return Object.freeze({
    usage: Object.freeze({
      inputTokens,
      outputTokens: input.maxOutputTokens,
      totalTokens: inputTokens + input.maxOutputTokens,
      estimatedCostMicros: null,
    }),
    pricingMetadataVersion: 'unconfigured',
  });
}

export function toPreview(
  input: PreviewInput,
  generation: Awaited<ReturnType<GenerationCall>>,
): NormalizedPreview {
  return Object.freeze({
    content: generation.content.slice(0, 50_000),
    summary: input.preview.summary.slice(0, 2_000),
    finishReason: generation.finishReason,
    providerRequestId: generation.providerRequestId,
    usage: generation.usage,
  });
}

type GenerationCall = () => Promise<{
  content: string;
  finishReason: NormalizedFinishReason;
  providerRequestId: string | null;
  usage: NormalizedUsage;
}>;

export function composePromptLayers(input: GenerationInput): Readonly<{
  system: string;
  user: string;
}> {
  const system = input.layers
    .filter((layer) => layer.kind === 'platform-policy')
    .map((layer) => layer.content)
    .join('\n\n');
  const user = input.layers
    .filter((layer) => layer.kind !== 'platform-policy')
    .map((layer) => `[${layer.kind}]\n${layer.content}`)
    .join('\n\n');
  return Object.freeze({ system, user });
}

export async function fetchJson(
  dependencies: ProviderAdapterDependencies,
  url: URL,
  init: RequestInit,
): Promise<Readonly<{ data: unknown; providerRequestId: string | null }>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), dependencies.timeoutMs);
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => reject(new ProviderFailure('TIMEOUT', { retryable: true })),
      { once: true },
    );
  });
  let response: Response;
  try {
    response = await Promise.race([
      dependencies.fetch(url, { ...init, signal: controller.signal }),
      aborted,
    ]);
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof ProviderFailure) throw error;
    if (controller.signal.aborted || isAbortError(error)) {
      throw new ProviderFailure('TIMEOUT', { retryable: true });
    }
    throw new ProviderFailure('PROVIDER_UNAVAILABLE', { retryable: true });
  }
  try {
    const providerRequestId = safeRequestId(response.headers);
    if (!response.ok) {
      throw classifyHttpStatus(response.status, providerRequestId);
    }

    let raw: string;
    try {
      raw = await Promise.race([response.text(), aborted]);
    } catch (error) {
      if (error instanceof ProviderFailure) throw error;
      if (controller.signal.aborted || isAbortError(error)) {
        throw new ProviderFailure('TIMEOUT', { retryable: true });
      }
      throw new ProviderFailure('INVALID_RESPONSE', { providerRequestId });
    }
    const maxEnvelopeCharacters = Math.max(4_096, dependencies.maxOutputCharacters * 4);
    if (raw.length > maxEnvelopeCharacters) {
      throw new ProviderFailure('INVALID_RESPONSE', { providerRequestId });
    }
    try {
      return Object.freeze({ data: JSON.parse(raw) as unknown, providerRequestId });
    } catch {
      throw new ProviderFailure('INVALID_RESPONSE', { providerRequestId });
    }
  } finally {
    clearTimeout(timer);
  }
}

function classifyHttpStatus(status: number, providerRequestId: string | null): ProviderFailure {
  if (status === 401) return new ProviderFailure('AUTHENTICATION_FAILED', { providerRequestId });
  if (status === 403) return new ProviderFailure('AUTHORIZATION_FAILED', { providerRequestId });
  if (status === 404) return new ProviderFailure('MODEL_UNAVAILABLE', { providerRequestId });
  if (status === 429 || status >= 500) {
    return new ProviderFailure('PROVIDER_UNAVAILABLE', {
      retryable: true,
      providerRequestId,
    });
  }
  return new ProviderFailure('INPUT_INVALID', { providerRequestId });
}

function safeRequestId(headers: Headers): string | null {
  const value =
    headers.get('x-request-id') ??
    headers.get('request-id') ??
    headers.get('x-goog-request-id') ??
    null;
  const parsed = ProviderRequestIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function usage(inputTokens: number, outputTokens: number): NormalizedUsage {
  return Object.freeze({
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedCostMicros: null,
  });
}

export function assertBoundedText(text: string, maxCharacters: number): string {
  const normalized = text.trim();
  if (!normalized || normalized.length > maxCharacters) {
    throw new ProviderFailure('INVALID_RESPONSE');
  }
  return normalized;
}

const StructuredContentSchema = z.object({ content: z.string() }).strict();

export function parseStructuredContent(text: string, maxCharacters: number): string {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text) as unknown;
  } catch {
    throw new ProviderFailure('INVALID_RESPONSE');
  }
  const parsed = StructuredContentSchema.safeParse(parsedJson);
  if (!parsed.success) throw new ProviderFailure('INVALID_RESPONSE');
  return assertBoundedText(parsed.data.content, maxCharacters);
}
