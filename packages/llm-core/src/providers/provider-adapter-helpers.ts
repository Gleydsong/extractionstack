import {
  CredentialModeSchema,
  LlmProviderSchema,
  type CredentialMode,
  type LlmProvider,
} from '@extractionstack/shared';
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
  capabilities: ProviderCapabilities;
}>;

const DependenciesSchema = z
  .object({
    fetch: z.function(),
    baseUrl: z.instanceof(URL),
    timeoutMs: z.number().int().positive().max(300_000),
    maxOutputCharacters: z.number().int().positive().max(100_000),
    capabilities: z.unknown(),
  })
  .strict();

const ProviderCapabilitiesSchema = z
  .object({
    provider: LlmProviderSchema,
    credentialModes: z.array(CredentialModeSchema).min(1).max(3),
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
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.models).size !== value.models.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['models'],
        message: 'Duplicate model',
      });
    }
    if (value.maxOutputTokens > value.contextWindowTokens) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxOutputTokens'],
        message: 'Output limit exceeds context window',
      });
    }
  });

export type NormalizedFinishReason = 'complete' | 'length' | 'blocked';

export function parseDependencies(
  dependencies: ProviderAdapterDependencies,
  expectedProvider: LlmProvider,
  expectedModes: readonly CredentialMode[],
  requiresStructuredOutput: boolean,
): ProviderAdapterDependencies {
  const parsed = DependenciesSchema.safeParse(dependencies);
  if (!parsed.success) {
    throw new ProviderFailure('INPUT_INVALID');
  }
  const capabilities = parseCapabilities(
    dependencies.capabilities,
    expectedProvider,
    expectedModes,
    requiresStructuredOutput,
  );
  const baseUrl = new URL(dependencies.baseUrl);
  if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname += '/';
  return Object.freeze({ ...dependencies, baseUrl, capabilities });
}

export function parseCapabilities(
  input: ProviderCapabilities,
  expectedProvider: LlmProvider,
  expectedModes: readonly CredentialMode[],
  requiresStructuredOutput: boolean,
): ProviderCapabilities {
  const parsed = ProviderCapabilitiesSchema.safeParse(input);
  const value = parsed.success ? parsed.data : null;
  if (
    !value ||
    value.provider !== expectedProvider ||
    value.credentialModes.length !== expectedModes.length ||
    !value.credentialModes.every((mode, index) => mode === expectedModes[index]) ||
    value.supportsStructuredOutput !== requiresStructuredOutput ||
    value.supportsCancellation ||
    value.supportsCredentialRefresh
  ) {
    throw new ProviderFailure('INPUT_INVALID');
  }
  return Object.freeze({
    ...value,
    credentialModes: Object.freeze([...value.credentialModes]),
    models: Object.freeze([...value.models]),
    oauthScopes: Object.freeze([...value.oauthScopes]),
  });
}

export function assertGenerationInput(
  expectedProvider: LlmProvider,
  input: GenerationInput,
  configuredCapabilities: ProviderCapabilities,
): GenerationInput {
  const parsed = GenerationInputSchema.safeParse(input);
  if (!parsed.success || parsed.data.provider !== expectedProvider) {
    throw new ProviderFailure('INPUT_INVALID');
  }
  if (!configuredCapabilities.models.includes(parsed.data.model)) {
    throw new ProviderFailure('MODEL_UNAVAILABLE');
  }
  if (parsed.data.maxOutputTokens > configuredCapabilities.maxOutputTokens) {
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

export function estimateUsage(
  input: GenerationInput,
  configuredCapabilities: ProviderCapabilities,
): UsageEstimate {
  const inputCharacters = input.layers.reduce((total, layer) => total + layer.content.length, 0);
  const inputTokens = Math.ceil(inputCharacters / 4);
  return Object.freeze({
    usage: Object.freeze({
      inputTokens,
      outputTokens: input.maxOutputTokens,
      totalTokens: inputTokens + input.maxOutputTokens,
      estimatedCostMicros: null,
    }),
    pricingMetadataVersion: configuredCapabilities.pricingMetadataVersion,
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
  const externalSignal = init.signal;
  const abortFromExternal = () => controller.abort();
  externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
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
    externalSignal?.removeEventListener('abort', abortFromExternal);
    if (externalSignal?.aborted) {
      throw new ProviderFailure('REQUEST_CANCELLED');
    }
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

    const maxEnvelopeBytes = Math.max(4_096, dependencies.maxOutputCharacters * 4);
    const raw = await readBoundedBody(
      response,
      maxEnvelopeBytes,
      aborted,
      controller,
      providerRequestId,
    );
    try {
      return Object.freeze({ data: JSON.parse(raw) as unknown, providerRequestId });
    } catch {
      throw new ProviderFailure('INVALID_RESPONSE', { providerRequestId });
    }
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abortFromExternal);
  }
}

function classifyHttpStatus(status: number, providerRequestId: string | null): ProviderFailure {
  if (status === 401) return new ProviderFailure('AUTHENTICATION_FAILED', { providerRequestId });
  if (status === 403) return new ProviderFailure('AUTHORIZATION_FAILED', { providerRequestId });
  if (status === 404) return new ProviderFailure('MODEL_UNAVAILABLE', { providerRequestId });
  if (status === 408) {
    return new ProviderFailure('TIMEOUT', { retryable: true, providerRequestId });
  }
  if (status === 429 || status >= 500) {
    return new ProviderFailure('PROVIDER_UNAVAILABLE', {
      retryable: true,
      providerRequestId,
    });
  }
  return new ProviderFailure('INPUT_INVALID', { providerRequestId });
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  aborted: Promise<never>,
  controller: AbortController,
  providerRequestId: string | null,
): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    controller.abort();
    throw new ProviderFailure('INVALID_RESPONSE', { providerRequestId });
  }
  if (!response.body) {
    let raw: string;
    try {
      raw = await Promise.race([response.text(), aborted]);
    } catch (error) {
      throw classifyBodyReadFailure(error, controller, providerRequestId);
    }
    if (new TextEncoder().encode(raw).byteLength > maxBytes) {
      controller.abort();
      throw new ProviderFailure('INVALID_RESPONSE', { providerRequestId });
    }
    return raw;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const decodedChunks: string[] = [];
  let receivedBytes = 0;
  let streamComplete = false;
  try {
    while (!streamComplete) {
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await Promise.race([reader.read(), aborted]);
      } catch (error) {
        throw classifyBodyReadFailure(error, controller, providerRequestId);
      }
      if (result.done) {
        streamComplete = true;
        continue;
      }
      receivedBytes += result.value.byteLength;
      if (receivedBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The normalized oversized-response failure remains authoritative.
        }
        controller.abort();
        throw new ProviderFailure('INVALID_RESPONSE', { providerRequestId });
      }
      try {
        decodedChunks.push(decoder.decode(result.value, { stream: true }));
      } catch {
        throw new ProviderFailure('INVALID_RESPONSE', { providerRequestId });
      }
    }
    try {
      decodedChunks.push(decoder.decode());
    } catch {
      throw new ProviderFailure('INVALID_RESPONSE', { providerRequestId });
    }
    return decodedChunks.join('');
  } finally {
    reader.releaseLock();
  }
}

function classifyBodyReadFailure(
  error: unknown,
  controller: AbortController,
  providerRequestId: string | null,
): ProviderFailure {
  if (error instanceof ProviderFailure) return error;
  if (controller.signal.aborted || isAbortError(error)) {
    return new ProviderFailure('TIMEOUT', { retryable: true, providerRequestId });
  }
  return new ProviderFailure('PROVIDER_UNAVAILABLE', {
    retryable: true,
    providerRequestId,
  });
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
