import { z } from 'zod';

export const LlmProviderSchema = z.enum(['FAKE', 'OPENAI', 'GEMINI']);
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

export const CredentialModeSchema = z.enum(['OAUTH', 'API_KEY', 'PLATFORM_CREDITS']);
export type CredentialMode = z.infer<typeof CredentialModeSchema>;

export const PublicIdSchema = z.string().cuid().max(64);
export type PublicId = z.infer<typeof PublicIdSchema>;

export const PublicIsoDateTimeSchema = z.string().max(40).datetime();
export type PublicIsoDateTime = z.infer<typeof PublicIsoDateTimeSchema>;

const PROVIDER_CREDENTIAL_MODES = {
  FAKE: ['PLATFORM_CREDITS'],
  OPENAI: ['API_KEY', 'PLATFORM_CREDITS'],
  GEMINI: ['OAUTH', 'API_KEY', 'PLATFORM_CREDITS'],
} as const satisfies Record<
  z.infer<typeof LlmProviderSchema>,
  readonly z.infer<typeof CredentialModeSchema>[]
>;

export const ProviderAuthorizationSchema = z
  .object({
    provider: LlmProviderSchema,
    credentialMode: CredentialModeSchema,
  })
  .strict()
  .superRefine(({ provider, credentialMode }, context) => {
    const allowedModes: readonly CredentialMode[] = PROVIDER_CREDENTIAL_MODES[provider];

    if (!allowedModes.includes(credentialMode)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['credentialMode'],
        message: `${credentialMode} is not supported by ${provider}`,
      });
    }
  });
export type ProviderAuthorization = z.infer<typeof ProviderAuthorizationSchema>;

const PublicProviderCapabilitiesBaseShape = {
  models: z.array(z.string().trim().min(1).max(128)).max(100).readonly(),
  contextWindowTokens: z.number().int().positive().max(10_000_000),
  maxOutputTokens: z.number().int().positive().max(1_000_000),
  supportsStructuredOutput: z.boolean(),
  supportsCancellation: z.boolean(),
  supportsCredentialRefresh: z.boolean(),
  previewEligible: z.boolean(),
  enabled: z.boolean(),
  circuitBreakerOpen: z.boolean(),
} as const;

export const PublicProviderCapabilitiesSchema = z
  .discriminatedUnion('provider', [
    z
      .object({
        provider: z.literal('FAKE'),
        credentialModes: z.tuple([z.literal('PLATFORM_CREDITS')]).readonly(),
        ...PublicProviderCapabilitiesBaseShape,
      })
      .strict(),
    z
      .object({
        provider: z.literal('OPENAI'),
        credentialModes: z.tuple([z.literal('API_KEY'), z.literal('PLATFORM_CREDITS')]).readonly(),
        ...PublicProviderCapabilitiesBaseShape,
      })
      .strict(),
    z
      .object({
        provider: z.literal('GEMINI'),
        credentialModes: z
          .union([
            z.tuple([z.literal('API_KEY'), z.literal('PLATFORM_CREDITS')]),
            z.tuple([z.literal('OAUTH'), z.literal('API_KEY'), z.literal('PLATFORM_CREDITS')]),
          ])
          .readonly(),
        ...PublicProviderCapabilitiesBaseShape,
      })
      .strict(),
  ])
  .readonly();
export type PublicProviderCapabilities = z.infer<typeof PublicProviderCapabilitiesSchema>;

export const PublicProviderCapabilitiesListSchema = z
  .array(PublicProviderCapabilitiesSchema)
  .max(20)
  .readonly();

export const GeminiOAuthStartResponseSchema = z
  .object({
    state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    authorizationUrl: z.string().url().max(4_096).refine(isHttpsUrl, 'OAuth URL must use HTTPS'),
  })
  .strict()
  .superRefine(({ state, authorizationUrl }, context) => {
    if (readUrlState(authorizationUrl) !== state) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authorizationUrl'],
        message: 'OAuth URL state must match response state',
      });
    }
  })
  .readonly();
export type GeminiOAuthStartResponse = z.infer<typeof GeminiOAuthStartResponseSchema>;

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function readUrlState(value: string): string | null {
  try {
    return new URL(value).searchParams.get('state');
  } catch {
    return null;
  }
}

function validateProviderAuthorization(
  value: ProviderAuthorization,
  context: z.RefinementCtx,
): void {
  const result = ProviderAuthorizationSchema.safeParse({
    provider: value.provider,
    credentialMode: value.credentialMode,
  });

  if (!result.success) {
    for (const issue of result.error.issues) {
      context.addIssue({ ...issue, path: issue.path });
    }
  }
}

const AiConnectionObjectSchema = z
  .object({
    id: PublicIdSchema,
    provider: LlmProviderSchema,
    displayLabel: z.string().trim().min(1).max(120),
    credentialMode: CredentialModeSchema,
    state: z.enum(['PENDING', 'ACTIVE', 'EXPIRED', 'REVOKED', 'INVALID']),
    maskedCredential: z.string().trim().min(1).max(32).nullable(),
    scopes: z.array(z.string().trim().min(1).max(160)).max(30),
    expiresAt: PublicIsoDateTimeSchema.nullable(),
    validatedAt: PublicIsoDateTimeSchema.nullable(),
    lastUsedAt: PublicIsoDateTimeSchema.nullable(),
    createdAt: PublicIsoDateTimeSchema,
    updatedAt: PublicIsoDateTimeSchema,
  })
  .strict();

export const AiConnectionSchema = AiConnectionObjectSchema.superRefine(
  validateProviderAuthorization,
);
export type AiConnection = z.infer<typeof AiConnectionSchema>;
