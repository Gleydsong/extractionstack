import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const RuntimeEnvBaseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  /** Comma-separated list of allowed origins for CORS. */
  CORS_ORIGIN: z.string().min(1).default('http://localhost:5173'),
  /** Optional: kept for backwards compatibility / future Auth0 re-integration. */
  AUTH0_DOMAIN: z.string().optional(),
  AUTH0_AUDIENCE: z.string().optional(),
  /** Bypass auth with a synthetic dev user. Rejected in production. */
  AUTH_DEV_MODE: booleanString,
  VITE_AUTH_DEV_MODE: booleanString,
  /** HS256 secret used to sign local JWTs. Required in production. */
  LOCAL_JWT_SECRET: z
    .string()
    .min(16, 'LOCAL_JWT_SECRET must be at least 16 characters')
    .default('dev-local-jwt-secret-please-change-in-production'),
  /** Lifetime of the issued JWT (seconds). */
  LOCAL_JWT_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(60 * 60 * 24),
  /** When false, only local + Google login are accepted (Auth0 path disabled). */
  AUTH_PROVIDERS: z.string().default('local,google'),
  /** Google OAuth credentials. Optional in dev (button shows a friendly message). */
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  /** Where Google redirects after consent. Must match a Google Authorized redirect URI. */
  GOOGLE_REDIRECT_URI: z
    .string()
    .url()
    .default('http://localhost:3001/auth/google/callback'),
  /** Frontend origin used to redirect after Google OAuth completes. */
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),

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
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export const RuntimeEnvSchema = RuntimeEnvBaseSchema.superRefine((env, ctx) => {
  if (env.NODE_ENV !== 'production') return;

  if (env.AUTH_DEV_MODE || env.VITE_AUTH_DEV_MODE) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'development auth is forbidden' });
  }
  if (env.CORS_ORIGIN.split(',').some((origin) => origin.trim() === '*')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'wildcard CORS is forbidden' });
  }
  if (/please-change-in-production/i.test(env.LOCAL_JWT_SECRET)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'LOCAL_JWT_SECRET must be set to a strong value in production',
    });
  }
  if (env.AUTH0_DOMAIN && /your-tenant|replace-me/i.test(env.AUTH0_DOMAIN)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a real AUTH0_DOMAIN is required' });
  }
  if (env.AUTH0_AUDIENCE && /replace-me/i.test(env.AUTH0_AUDIENCE)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a real AUTH0_AUDIENCE is required' });
  }
});

export type RuntimeEnv = z.infer<typeof RuntimeEnvSchema>;

export function loadRuntimeEnv(input: NodeJS.ProcessEnv | Record<string, string | undefined>): RuntimeEnv {
  return RuntimeEnvSchema.parse(input);
}
