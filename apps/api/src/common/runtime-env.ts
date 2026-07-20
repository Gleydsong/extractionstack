import { z } from 'zod';
import { isCanonicalCredentialMasterKey } from './credential-master-key.js';
import * as ipaddr from 'ipaddr.js';

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const base64Encoded32Bytes = z
  .string()
  .refine(isCanonicalCredentialMasterKey, 'must be a base64-encoded 32-byte key');

const modelAllowlist = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value, context) => {
      const models = [
        ...new Set(
          value
            .split(',')
            .map((model) => model.trim())
            .filter(Boolean),
        ),
      ];
      if (models.length < 1 || models.length > 50 || models.some((model) => model.length > 128)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid model allowlist' });
        return z.NEVER;
      }

      return Object.freeze(models);
    });

const boundedCanonicalInteger = (minimum: number, maximum: number, fallback: number) =>
  z
    .union([
      z.number().int(),
      z
        .string()
        .regex(/^(0|[1-9]\d*)$/)
        .transform(Number),
    ])
    .pipe(z.number().int().min(minimum).max(maximum))
    .default(fallback);

const trustProxy = z.string().default('false').refine(isSafeTrustProxy, 'unsafe trust proxy');

const RuntimeEnvBaseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  CORS_ORIGIN: z.string().min(1).default('http://localhost:5173'),
  AUTH0_DOMAIN: z.string().optional(),
  AUTH0_AUDIENCE: z.string().optional(),
  AUTH_DEV_MODE: booleanString,
  VITE_AUTH_DEV_MODE: booleanString,
  DATABASE_URL: z
    .string()
    .min(1)
    .default('postgresql://extractionstack:extractionstack@localhost:5432/extractionstack'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  CRAWLER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(25_000),
  CRAWLER_MAX_REDIRECTS: z.coerce.number().int().min(0).max(10).default(5),
  CRAWLER_MAX_HTML_BYTES: z.coerce
    .number()
    .int()
    .min(64 * 1024)
    .max(20 * 1024 * 1024)
    .default(5 * 1024 * 1024),
  CRAWLER_MAX_RESPONSES: z.coerce.number().int().min(10).max(10_000).default(1_000),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  THROTTLE_TTL_SECONDS: z.coerce.number().int().min(1).max(3_600).default(60),
  THROTTLE_LIMIT: z.coerce.number().int().min(1).max(10_000).default(10),
  METRICS_TOKEN: z.string().min(16).max(256).optional(),
  API_TRUST_PROXY: trustProxy,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LLM_PROVIDER_MODE: z.enum(['fake', 'live']).default('fake'),
  LLM_PROMPT_GENERATION_ENABLED: booleanString,
  LLM_PROVIDER_OPENAI_ENABLED: booleanString,
  LLM_PROVIDER_GEMINI_ENABLED: booleanString,
  LLM_PLATFORM_CREDITS_ENABLED: booleanString,
  LLM_CREDENTIAL_MASTER_KEY: z.preprocess(
    (value) => (value === '' ? undefined : value),
    base64Encoded32Bytes.optional(),
  ),
  LLM_CREDENTIAL_KEY_VERSION: z.string().trim().min(1).max(64).optional(),
  LLM_OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  LLM_GEMINI_BASE_URL: z.string().url().default('https://generativelanguage.googleapis.com/v1beta'),
  LLM_OPENAI_MODEL_ALLOWLIST: modelAllowlist('gpt-5-mini'),
  LLM_GEMINI_MODEL_ALLOWLIST: modelAllowlist('gemini-2.5-flash'),
  LLM_TIMEOUT_MS: boundedCanonicalInteger(1_000, 120_000, 30_000),
  LLM_MAX_INPUT_TOKENS: boundedCanonicalInteger(1, 1_000_000, 32_000),
  LLM_MAX_OUTPUT_TOKENS: boundedCanonicalInteger(1, 1_000_000, 4_096),
  LLM_MAX_COST_MINOR_UNITS: boundedCanonicalInteger(0, 1_000_000, 500),
  LLM_PRICING_VERSION: z.string().trim().min(1).max(64).default('unconfigured-v1'),
  LLM_PRICING_CATALOG_JSON: z.string().trim().min(2).max(65_536).default('[]'),
  LLM_RATE_LIMIT_HMAC_KEY: z.string().min(32).max(256).default('local-development-rate-limit-key'),
  LLM_MAX_ACTIVE_JOBS_PER_USER: boundedCanonicalInteger(1, 50, 3),
  LLM_DAILY_PLATFORM_CREDIT_BUDGET_MINOR: boundedCanonicalInteger(1, 1_000_000_000_000, 10_000),
  LLM_FAKE_INITIAL_CREDITS_MINOR: boundedCanonicalInteger(1, 1_000_000, 1_000),
});

export const RuntimeEnvSchema = RuntimeEnvBaseSchema.superRefine((env, ctx) => {
  if (env.NODE_ENV !== 'production') return;

  if (env.AUTH_DEV_MODE || env.VITE_AUTH_DEV_MODE) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'development auth is forbidden' });
  }
  if (env.CORS_ORIGIN.split(',').some((origin) => origin.trim() === '*')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'wildcard CORS is forbidden' });
  }
  if (!env.AUTH0_DOMAIN || /your-tenant|replace-me/i.test(env.AUTH0_DOMAIN)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a real AUTH0_DOMAIN is required' });
  }
  if (!env.AUTH0_AUDIENCE || /replace-me/i.test(env.AUTH0_AUDIENCE)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a real AUTH0_AUDIENCE is required' });
  }
  if (env.LLM_PRICING_VERSION === 'unconfigured-v1' || env.LLM_PRICING_CATALOG_JSON === '[]') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'an explicit LLM pricing catalog is required',
    });
  }
  if (env.LLM_PROVIDER_MODE !== 'live') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'the fake LLM provider is forbidden' });
  }
  if (!env.LLM_CREDENTIAL_MASTER_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'an LLM credential master key is required',
    });
  }
  if (!env.LLM_CREDENTIAL_KEY_VERSION) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'an LLM credential key version is required',
    });
  }
  if (env.LLM_RATE_LIMIT_HMAC_KEY === 'local-development-rate-limit-key') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'a dedicated rate-limit HMAC key is required',
    });
  }
  for (const endpoint of [env.LLM_OPENAI_BASE_URL, env.LLM_GEMINI_BASE_URL]) {
    if (new URL(endpoint).protocol !== 'https:') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'LLM provider URLs must use HTTPS' });
    }
  }
}).transform((parsedEnv) => {
  const env = {
    ...parsedEnv,
    LLM_CREDENTIAL_KEY_VERSION: parsedEnv.LLM_CREDENTIAL_KEY_VERSION ?? 'local-v1',
  };
  const masterKey = env.LLM_CREDENTIAL_MASTER_KEY;
  const rateLimitKey = env.LLM_RATE_LIMIT_HMAC_KEY;

  if (masterKey !== undefined) {
    Object.defineProperty(env, 'LLM_CREDENTIAL_MASTER_KEY', {
      configurable: false,
      enumerable: false,
      value: masterKey,
      writable: false,
    });
  }
  Object.defineProperty(env, 'LLM_RATE_LIMIT_HMAC_KEY', {
    configurable: false,
    enumerable: false,
    value: rateLimitKey,
    writable: false,
  });
  Object.defineProperty(env, 'toJSON', {
    configurable: false,
    enumerable: false,
    value: () => ({ ...env }),
    writable: false,
  });

  return env;
});

export type RuntimeEnv = z.infer<typeof RuntimeEnvSchema>;

export function loadRuntimeEnv(
  input: NodeJS.ProcessEnv | Record<string, string | undefined>,
): RuntimeEnv {
  return RuntimeEnvSchema.parse(input);
}

function isSafeTrustProxy(value: string): boolean {
  if (['false', 'loopback', 'linklocal', 'uniquelocal', '1', '2'].includes(value)) return true;
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length < 1 || entries.length > 16) return false;
  try {
    return entries.every((entry) => {
      const [address] = ipaddr.parseCIDR(entry);
      return ['private', 'loopback', 'linkLocal', 'uniqueLocal'].includes(address.range());
    });
  } catch {
    return false;
  }
}
