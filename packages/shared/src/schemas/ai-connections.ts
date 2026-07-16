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
