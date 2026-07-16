import { z } from 'zod';
import type {
  ConnectionValidation,
  GenerationInput,
  LlmProviderAdapter,
  NormalizedGeneration,
  NormalizedPreview,
  PreviewInput,
  ProviderCapabilities,
  UsageEstimate,
  ValidateConnectionInput,
} from './provider-adapter';
import {
  assertGenerationInput,
  assertValidationInput,
  capabilities,
  composePromptLayers,
  estimateUsage,
  fetchJson,
  parseDependencies,
  parseStructuredContent,
  type ProviderAdapterDependencies,
  toPreview,
  usage,
} from './provider-adapter-helpers';
import { ProviderFailure } from './provider-errors';

export type { ProviderAdapterDependencies } from './provider-adapter-helpers';

const GeminiResponseSchema = z
  .object({
    responseId: z.string().optional(),
    promptFeedback: z.object({ blockReason: z.string().optional() }).passthrough().optional(),
    candidates: z
      .array(
        z
          .object({
            content: z
              .object({
                parts: z.array(z.object({ text: z.string().optional() }).passthrough()),
              })
              .passthrough(),
            finishReason: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    usageMetadata: z
      .object({
        promptTokenCount: z.number().int().nonnegative(),
        candidatesTokenCount: z.number().int().nonnegative().default(0),
      })
      .passthrough(),
  })
  .passthrough();

const GEMINI_CAPABILITIES = capabilities('GEMINI', ['OAUTH', 'API_KEY', 'PLATFORM_CREDITS'], true);
const BLOCKED_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'LANGUAGE',
]);

export class GeminiProviderAdapter implements LlmProviderAdapter {
  readonly provider = 'GEMINI' as const;
  private readonly dependencies: ProviderAdapterDependencies;

  constructor(dependencies: ProviderAdapterDependencies) {
    this.dependencies = parseDependencies(dependencies);
  }

  getCapabilities(): ProviderCapabilities {
    return GEMINI_CAPABILITIES;
  }

  async validateConnection(input: ValidateConnectionInput): Promise<ConnectionValidation> {
    assertValidationInput(this.provider, input);
    return Object.freeze({ valid: true, expiresAt: null, scopes: Object.freeze([]) });
  }

  async estimateUsage(input: GenerationInput): Promise<UsageEstimate> {
    return estimateUsage(assertGenerationInput(this.provider, input));
  }

  async generatePrompt(input: GenerationInput): Promise<NormalizedGeneration> {
    const parsedInput = assertGenerationInput(this.provider, input);
    const prompt = composePromptLayers(parsedInput);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (parsedInput.credential.mode === 'API_KEY') {
      headers['x-goog-api-key'] = parsedInput.credential.value;
    } else {
      headers.authorization = `Bearer ${parsedInput.credential.value}`;
    }
    const endpoint = `models/${encodeURIComponent(parsedInput.model)}:generateContent`;
    const { data, providerRequestId: headerRequestId } = await fetchJson(
      this.dependencies,
      new URL(endpoint, this.dependencies.baseUrl),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...(prompt.system ? { systemInstruction: { parts: [{ text: prompt.system }] } } : {}),
          contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
          generationConfig: {
            maxOutputTokens: parsedInput.maxOutputTokens,
            candidateCount: 1,
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              properties: { content: { type: 'STRING' } },
              required: ['content'],
            },
          },
        }),
      },
    );
    const response = GeminiResponseSchema.safeParse(data);
    if (!response.success) throw new ProviderFailure('INVALID_RESPONSE');
    const candidate = response.data.candidates?.[0];
    const text = candidate?.content.parts.map((part) => part.text ?? '').join('') ?? '';
    const content = parseStructuredContent(text, this.dependencies.maxOutputCharacters);
    const providerReason = candidate?.finishReason ?? '';
    const finishReason = finishReasonFor(providerReason);
    return Object.freeze({
      content,
      finishReason,
      providerRequestId: safeId(response.data.responseId) ?? headerRequestId,
      usage: usage(
        response.data.usageMetadata.promptTokenCount,
        response.data.usageMetadata.candidatesTokenCount,
      ),
    });
  }

  async generatePreview(input: PreviewInput): Promise<NormalizedPreview> {
    const generation = await this.generatePrompt(input.generation);
    return toPreview(input, generation);
  }
}

function safeId(value: string | undefined): string | null {
  return value && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value) ? value : null;
}

function finishReasonFor(reason: string): 'complete' | 'length' | 'blocked' {
  if (reason === 'STOP') return 'complete';
  if (reason === 'MAX_TOKENS') return 'length';
  if (BLOCKED_REASONS.has(reason)) return 'blocked';
  throw new ProviderFailure('INVALID_RESPONSE');
}
