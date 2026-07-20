import { PricingCatalog } from '@extractionstack/llm-core';
import { loadRuntimeEnv } from '../common/runtime-env.js';

export function createApiPricingCatalog(input: NodeJS.ProcessEnv): PricingCatalog {
  const env = loadRuntimeEnv(input);
  let entries: unknown;
  try {
    entries = JSON.parse(env.LLM_PRICING_CATALOG_JSON);
  } catch {
    throw new Error('LLM_PRICING_CATALOG_INVALID');
  }
  if (!Array.isArray(entries)) throw new Error('LLM_PRICING_CATALOG_INVALID');
  const catalog = new PricingCatalog(env.LLM_PRICING_VERSION, entries);
  if (env.NODE_ENV === 'production' && env.LLM_PROVIDER_MODE === 'live') {
    for (const [provider, models] of [
      ['OPENAI', env.LLM_OPENAI_MODEL_ALLOWLIST],
      ['GEMINI', env.LLM_GEMINI_MODEL_ALLOWLIST],
    ] as const) {
      if (models.some((model) => !catalog.has(provider, model))) {
        throw new Error('LLM_PRICING_CATALOG_INCOMPLETE');
      }
    }
  }
  if (
    env.LLM_PROVIDER_MODE === 'fake' &&
    env.LLM_PROMPT_GENERATION_ENABLED &&
    !catalog.has('FAKE', 'fake-deterministic-v1')
  ) {
    throw new Error('LLM_PRICING_CATALOG_INCOMPLETE');
  }
  return catalog;
}
