import type { LlmProvider } from '@extractionstack/shared';
import { z } from 'zod';
import type { NormalizedUsage } from '../providers/provider-adapter';

const RATE_DENOMINATOR = 1_000_000n;
const MICROS_PER_MINOR = 10_000n;
const RateSchema = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
const EntrySchema = z
  .object({
    provider: z.enum(['OPENAI', 'GEMINI']),
    model: z.string().trim().min(1).max(128),
    inputMicrosPerMillionTokens: RateSchema,
    cachedInputMicrosPerMillionTokens: RateSchema,
    outputMicrosPerMillionTokens: RateSchema,
    reasoningMicrosPerMillionTokens: RateSchema,
    requireCachedTokens: z.boolean(),
    requireReasoningTokens: z.boolean(),
  })
  .strict();

export type PricingEntry = z.input<typeof EntrySchema>;
export type PricedUsage = Readonly<{
  pricingVersion: string;
  amountMicros: bigint;
  amountMinor: bigint;
}>;

export class PricingFailure extends Error {
  constructor(readonly code: 'PRICING_NOT_CONFIGURED' | 'PRICING_USAGE_INSUFFICIENT') {
    super(code);
    this.name = 'PricingFailure';
  }
}

export class PricingCatalog {
  private readonly entries: ReadonlyMap<string, z.infer<typeof EntrySchema>>;
  constructor(
    readonly version: string,
    entries: readonly PricingEntry[],
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version))
      throw new PricingFailure('PRICING_NOT_CONFIGURED');
    const map = new Map<string, z.infer<typeof EntrySchema>>();
    for (const raw of entries) {
      const entry = EntrySchema.parse(raw);
      const key = `${entry.provider}:${entry.model}`;
      if (map.has(key)) throw new PricingFailure('PRICING_NOT_CONFIGURED');
      map.set(key, Object.freeze(entry));
    }
    this.entries = map;
  }

  price(provider: LlmProvider, model: string, usage: NormalizedUsage): PricedUsage {
    const entry = this.entries.get(`${provider}:${model}`);
    if (!entry) throw new PricingFailure('PRICING_NOT_CONFIGURED');
    if (
      (entry.requireCachedTokens && usage.cachedInputTokens === undefined) ||
      (entry.requireReasoningTokens && usage.reasoningTokens === undefined)
    )
      throw new PricingFailure('PRICING_USAGE_INSUFFICIENT');
    const cached = usage.cachedInputTokens ?? 0;
    const reasoning = usage.reasoningTokens ?? 0;
    if (cached > usage.inputTokens || reasoning > usage.outputTokens)
      throw new PricingFailure('PRICING_USAGE_INSUFFICIENT');
    const normalInput = usage.inputTokens - cached;
    const normalOutput = usage.outputTokens - reasoning;
    const numerator =
      BigInt(normalInput) * BigInt(entry.inputMicrosPerMillionTokens) +
      BigInt(cached) * BigInt(entry.cachedInputMicrosPerMillionTokens) +
      BigInt(normalOutput) * BigInt(entry.outputMicrosPerMillionTokens) +
      BigInt(reasoning) * BigInt(entry.reasoningMicrosPerMillionTokens);
    const amountMicros = ceilDiv(numerator, RATE_DENOMINATOR);
    return Object.freeze({
      pricingVersion: this.version,
      amountMicros,
      amountMinor: ceilDiv(amountMicros, MICROS_PER_MINOR),
    });
  }

  has(provider: LlmProvider, model: string): boolean {
    return this.entries.has(`${provider}:${model}`);
  }

  quoteMaximum(
    provider: LlmProvider,
    model: string,
    maximumInputTokens: number,
    maximumOutputTokens: number,
  ): PricedUsage {
    assertTokenBound(maximumInputTokens);
    assertTokenBound(maximumOutputTokens);
    const entry = this.entries.get(`${provider}:${model}`);
    if (!entry) throw new PricingFailure('PRICING_NOT_CONFIGURED');
    const inputRate = maxBigInt(
      BigInt(entry.inputMicrosPerMillionTokens),
      BigInt(entry.cachedInputMicrosPerMillionTokens),
    );
    const outputRate = maxBigInt(
      BigInt(entry.outputMicrosPerMillionTokens),
      BigInt(entry.reasoningMicrosPerMillionTokens),
    );
    const numerator =
      BigInt(maximumInputTokens) * inputRate + BigInt(maximumOutputTokens) * outputRate;
    const amountMicros = ceilDiv(numerator, RATE_DENOMINATOR);
    return Object.freeze({
      pricingVersion: this.version,
      amountMicros,
      amountMinor: ceilDiv(amountMicros, MICROS_PER_MINOR),
    });
  }
}

function assertTokenBound(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647)
    throw new PricingFailure('PRICING_USAGE_INSUFFICIENT');
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function ceilDiv(value: bigint, divisor: bigint): bigint {
  return value === 0n ? 0n : (value + divisor - 1n) / divisor;
}
