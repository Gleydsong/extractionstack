import { z } from 'zod';

export const LlmProviderSchema = z.enum(['FAKE', 'OPENAI', 'GEMINI']);
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

export const CredentialModeSchema = z.enum(['OAUTH', 'API_KEY', 'PLATFORM_CREDITS']);
export type CredentialMode = z.infer<typeof CredentialModeSchema>;

export const PublicIdSchema = z.string().cuid().max(64);
export type PublicId = z.infer<typeof PublicIdSchema>;

export const AiConnectionSchema = z
  .object({
    id: PublicIdSchema,
    provider: LlmProviderSchema,
    displayLabel: z.string().trim().min(1).max(120),
    credentialMode: CredentialModeSchema,
    state: z.enum(['PENDING', 'ACTIVE', 'EXPIRED', 'REVOKED', 'INVALID']),
    maskedCredential: z.string().trim().min(1).max(32).nullable(),
    scopes: z.array(z.string().trim().min(1).max(160)).max(30),
    expiresAt: z.string().datetime().nullable(),
    validatedAt: z.string().datetime().nullable(),
    lastUsedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type AiConnection = z.infer<typeof AiConnectionSchema>;
