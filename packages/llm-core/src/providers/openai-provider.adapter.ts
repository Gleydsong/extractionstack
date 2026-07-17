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

const OpenAiResponseSchema = z
  .object({
    id: z.string().optional(),
    status: z.enum(['completed', 'incomplete']),
    incomplete_details: z.object({ reason: z.string() }).passthrough().nullish(),
    output: z.array(
      z
        .object({
          type: z.string(),
          content: z.array(
            z
              .object({
                type: z.string(),
                text: z.string().optional(),
              })
              .passthrough(),
          ),
        })
        .passthrough(),
    ),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
      })
      .passthrough(),
  })
  .passthrough();

export class OpenAiProviderAdapter implements LlmProviderAdapter {
  readonly provider = 'OPENAI' as const;
  private readonly dependencies: ProviderAdapterDependencies;

  constructor(dependencies: ProviderAdapterDependencies) {
    this.dependencies = parseDependencies(
      dependencies,
      this.provider,
      ['API_KEY', 'PLATFORM_CREDITS'],
      true,
    );
  }

  getCapabilities(): ProviderCapabilities {
    return this.dependencies.capabilities;
  }

  async validateConnection(input: ValidateConnectionInput): Promise<ConnectionValidation> {
    assertValidationInput(this.provider, input);
    return Object.freeze({ valid: true, expiresAt: null, scopes: Object.freeze([]) });
  }

  async estimateUsage(input: GenerationInput): Promise<UsageEstimate> {
    return estimateUsage(
      assertGenerationInput(this.provider, input, this.dependencies.capabilities),
      this.dependencies.capabilities,
    );
  }

  async generatePrompt(input: GenerationInput): Promise<NormalizedGeneration> {
    const parsedInput = assertGenerationInput(this.provider, input, this.dependencies.capabilities);
    const prompt = composePromptLayers(parsedInput);
    const { data, providerRequestId: headerRequestId } = await fetchJson(
      this.dependencies,
      new URL('responses', this.dependencies.baseUrl),
      {
        method: 'POST',
        signal: parsedInput.signal,
        headers: {
          authorization: `Bearer ${parsedInput.credential.value}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: parsedInput.model,
          input: [
            ...(prompt.system ? [{ role: 'system', content: prompt.system }] : []),
            { role: 'user', content: prompt.user },
          ],
          max_output_tokens: parsedInput.maxOutputTokens,
          tools: [],
          tool_choice: 'none',
          text: {
            format: {
              type: 'json_schema',
              name: 'generated_prompt',
              strict: true,
              schema: {
                type: 'object',
                properties: { content: { type: 'string' } },
                required: ['content'],
                additionalProperties: false,
              },
            },
          },
          store: false,
        }),
      },
    );
    const response = OpenAiResponseSchema.safeParse(data);
    if (!response.success) throw new ProviderFailure('INVALID_RESPONSE');
    const text = response.data.output
      .flatMap((item) => item.content)
      .filter((item) => item.type === 'output_text')
      .map((item) => item.text ?? '')
      .join('');
    const content = parseStructuredContent(text, this.dependencies.maxOutputCharacters);
    const reason = response.data.incomplete_details?.reason;
    const finishReason = finishReasonFor(response.data.status, reason);
    return Object.freeze({
      content,
      finishReason,
      providerRequestId: headerRequestId ?? safeId(response.data.id),
      usage: usage(response.data.usage.input_tokens, response.data.usage.output_tokens),
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

function finishReasonFor(
  status: 'completed' | 'incomplete',
  reason: string | null | undefined,
): 'complete' | 'length' | 'blocked' {
  if (status === 'completed') return 'complete';
  if (reason === 'max_output_tokens' || reason === 'max_tokens') return 'length';
  if (reason === 'content_filter') return 'blocked';
  throw new ProviderFailure('INVALID_RESPONSE');
}
