import { z } from 'zod';
import {
  CredentialModeSchema,
  LlmProviderSchema,
  ProviderAuthorizationSchema,
  PublicIdSchema,
  PublicIsoDateTimeSchema,
} from './ai-connections.js';

const PromptCategorySchema = z.enum([
  'application',
  'landing_page',
  'frontend',
  'backend',
  'api',
  'design_system',
  'documentation',
  'tests',
  'content',
  'custom',
]);

const PromptLanguageSchema = z.enum(['pt-BR', 'en-US', 'es-ES']);
const PromptDestinationSchema = z.enum([
  'universal',
  'codex',
  'chatgpt',
  'claude',
  'gemini',
  'cursor',
  'lovable',
  'bolt',
]);

export const MAXIMUM_COST_MINOR = 1_000_000_000_000n;

const PositiveCostMinorSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,12}$/)
  .refine((value) => BigInt(value) <= MAXIMUM_COST_MINOR, 'maximum cost exceeds the limit');

const MaximumCostMinorSchema = PositiveCostMinorSchema.nullable();

const PromptExecutionRequestObjectSchema = z
  .object({
    provider: LlmProviderSchema,
    model: z.string().trim().min(1).max(128),
    credentialMode: CredentialModeSchema,
    connectionId: PublicIdSchema.nullable(),
    acceptPlatformCharge: z.boolean(),
    maximumCostMinor: MaximumCostMinorSchema,
  })
  .strict();

function validateExecutionRequest(
  value: z.infer<typeof PromptExecutionRequestObjectSchema>,
  context: z.RefinementCtx,
): void {
  const authorization = ProviderAuthorizationSchema.safeParse({
    provider: value.provider,
    credentialMode: value.credentialMode,
  });
  if (!authorization.success) {
    for (const issue of authorization.error.issues) context.addIssue(issue);
  }
  if (value.credentialMode === 'PLATFORM_CREDITS') {
    if (value.connectionId !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['connectionId'],
        message: 'connection is not used for platform credits',
      });
    }
    if (value.maximumCostMinor === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maximumCostMinor'],
        message: 'maximum cost is required for platform credits',
      });
    }
  } else {
    if (value.connectionId === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['connectionId'],
        message: 'connection is required for user credentials',
      });
    }
    if (value.acceptPlatformCharge || value.maximumCostMinor !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['credentialMode'],
        message: 'platform charge fields are not accepted for user credentials',
      });
    }
  }
}

export const PromptGenerationRequestSchema =
  PromptExecutionRequestObjectSchema.superRefine(validateExecutionRequest);
export type PromptGenerationRequest = z.infer<typeof PromptGenerationRequestSchema>;

export const PromptAdaptationRequestSchema = PromptExecutionRequestObjectSchema.extend({
  destination: PromptDestinationSchema.exclude(['universal']),
}).superRefine(validateExecutionRequest);
export type PromptAdaptationRequest = z.infer<typeof PromptAdaptationRequestSchema>;

export const PromptPreviewRequestSchema =
  PromptExecutionRequestObjectSchema.superRefine(validateExecutionRequest);
export type PromptPreviewRequest = z.infer<typeof PromptPreviewRequestSchema>;

export const PromptProjectListQuerySchema = z
  .object({
    cursor: PublicIdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type PromptProjectListQuery = z.infer<typeof PromptProjectListQuerySchema>;

export const PromptJobStatusSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCEL_REQUESTED',
  'CANCELLED',
  'AMBIGUOUS',
]);
export type PromptJobStatus = z.infer<typeof PromptJobStatusSchema>;

export const PromptWizardInputSchema = z
  .object({
    extractionId: PublicIdSchema,
    category: PromptCategorySchema,
    objective: z.string().trim().min(10).max(2_000),
    audience: z.string().trim().min(2).max(500),
    technologies: z.array(z.string().trim().min(1).max(80)).max(30),
    exclusions: z.array(z.string().trim().min(1).max(200)).max(30),
    requirements: z.array(z.string().trim().min(1).max(500)).max(50),
    language: PromptLanguageSchema,
    detail: z.enum(['concise', 'balanced', 'complete']),
    destination: PromptDestinationSchema,
    freeInstructions: z.string().trim().max(8_000).default(''),
  })
  .strict();
export type PromptWizardInput = z.infer<typeof PromptWizardInputSchema>;

export const PromptCostEstimateRequestSchema = z
  .object({
    wizard: PromptWizardInputSchema,
    provider: LlmProviderSchema,
    model: z.string().trim().min(1).max(128),
  })
  .strict();
export type PromptCostEstimateRequest = z.infer<typeof PromptCostEstimateRequestSchema>;

export const PromptCostEstimateSchema = z
  .object({
    provider: LlmProviderSchema,
    model: z.string().trim().min(1).max(128),
    maximumInputTokens: z.number().int().positive().max(2_147_483_647),
    maximumOutputTokens: z.number().int().positive().max(1_000_000),
    maximumCostMinor: PositiveCostMinorSchema,
    pricingVersion: z.string().trim().min(1).max(64),
    quotedAt: PublicIsoDateTimeSchema,
  })
  .strict();
export type PromptCostEstimate = z.infer<typeof PromptCostEstimateSchema>;

export const PromptVersionCostEstimateRequestSchema = z.discriminatedUnion('operation', [
  z
    .object({
      provider: LlmProviderSchema,
      model: z.string().trim().min(1).max(128),
      operation: z.literal('ADAPT'),
      destination: PromptDestinationSchema.exclude(['universal']),
    })
    .strict(),
  z
    .object({
      provider: LlmProviderSchema,
      model: z.string().trim().min(1).max(128),
      operation: z.literal('PREVIEW'),
    })
    .strict(),
]);
export type PromptVersionCostEstimateRequest = z.infer<
  typeof PromptVersionCostEstimateRequestSchema
>;

export const PromptVersionCostEstimateSchema = PromptCostEstimateSchema.extend({
  sourceVersionId: PublicIdSchema,
  operation: z.enum(['ADAPT', 'PREVIEW']),
  reportSections: z
    .array(z.enum(['technologies', 'structure', 'evidence', 'limitations', 'confidence']))
    .length(5),
  retentionNotice: z.string().trim().min(1).max(500),
}).strict();
export type PromptVersionCostEstimate = z.infer<typeof PromptVersionCostEstimateSchema>;

export const PromptProjectSchema = z
  .object({
    id: PublicIdSchema,
    extractionId: PublicIdSchema,
    title: z.string().trim().min(1).max(200),
    category: PromptCategorySchema,
    language: PromptLanguageSchema,
    wizardInput: PromptWizardInputSchema,
    currentVersionId: PublicIdSchema.nullable(),
    state: z.enum(['ACTIVE', 'ARCHIVED']),
    createdAt: PublicIsoDateTimeSchema,
    updatedAt: PublicIsoDateTimeSchema,
  })
  .strict();
export type PromptProject = z.infer<typeof PromptProjectSchema>;

export const PromptProjectListResponseSchema = z
  .object({
    items: z.array(PromptProjectSchema).max(100),
    nextCursor: PublicIdSchema.nullable(),
  })
  .strict();
export type PromptProjectListResponse = z.infer<typeof PromptProjectListResponseSchema>;

export const PromptVersionSchema = z
  .object({
    id: PublicIdSchema,
    projectId: PublicIdSchema,
    sequence: z.number().int().positive(),
    sourceVersionId: PublicIdSchema.nullable(),
    kind: z.enum(['UNIVERSAL', 'ADAPTED']),
    destination: PromptDestinationSchema,
    content: z.string().trim().min(1).max(100_000),
    summary: z.string().trim().min(1).max(2_000),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/i),
    templateVersion: z.string().trim().min(1).max(32),
    reportSchemaVersion: z.number().int().positive(),
    provider: LlmProviderSchema.nullable(),
    model: z.string().trim().min(1).max(128).nullable(),
    createdAt: PublicIsoDateTimeSchema,
  })
  .strict();
export type PromptVersion = z.infer<typeof PromptVersionSchema>;

const PromptVersionPublicBaseShape = {
  id: PublicIdSchema,
  projectId: PublicIdSchema,
  sequence: z.number().int().positive(),
  sourceVersionId: PublicIdSchema.nullable(),
  kind: z.enum(['UNIVERSAL', 'ADAPTED']),
  destination: PromptDestinationSchema,
  summary: z.string().trim().min(1).max(2_000),
  provider: LlmProviderSchema.nullable(),
  model: z.string().trim().min(1).max(128).nullable(),
  createdAt: PublicIsoDateTimeSchema,
} as const;

export const PromptVersionSummarySchema = z.object(PromptVersionPublicBaseShape).strict();
export type PromptVersionSummary = z.infer<typeof PromptVersionSummarySchema>;

export const PromptVersionDetailSchema = z
  .object({
    ...PromptVersionPublicBaseShape,
    content: z.string().trim().min(1).max(100_000),
  })
  .strict();
export type PromptVersionDetail = z.infer<typeof PromptVersionDetailSchema>;

export const PromptVersionListQuerySchema = z
  .object({
    cursor: PublicIdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type PromptVersionListQuery = z.infer<typeof PromptVersionListQuerySchema>;

export const PromptVersionListResponseSchema = z
  .object({
    items: z.array(PromptVersionSummarySchema).max(100),
    nextCursor: PublicIdSchema.nullable(),
  })
  .strict();
export type PromptVersionListResponse = z.infer<typeof PromptVersionListResponseSchema>;

export const PromptVersionEditRequestSchema = z
  .object({ content: z.string().trim().min(1).max(100_000) })
  .strict();
export type PromptVersionEditRequest = z.infer<typeof PromptVersionEditRequestSchema>;

const PromptJobBaseSchema = z.object({
  id: PublicIdSchema,
  projectId: PublicIdSchema,
  operation: z.enum(['GENERATE', 'ADAPT', 'PREVIEW']),
  provider: LlmProviderSchema,
  model: z.string().trim().min(1).max(128),
  credentialMode: CredentialModeSchema,
  attempts: z.number().int().nonnegative().max(10),
  maxAttempts: z.number().int().min(1).max(10),
  sourcePromptVersionId: PublicIdSchema.nullable(),
  resultPromptVersionId: PublicIdSchema.nullable(),
  queuedAt: PublicIsoDateTimeSchema,
  startedAt: PublicIsoDateTimeSchema.nullable(),
  finishedAt: PublicIsoDateTimeSchema.nullable(),
  createdAt: PublicIsoDateTimeSchema,
  updatedAt: PublicIsoDateTimeSchema,
});

const PendingPromptJobSchema = PromptJobBaseSchema.extend({
  status: z.enum(['QUEUED', 'RUNNING', 'CANCEL_REQUESTED']),
  message: z.string().trim().min(1).max(1_000),
}).strict();

const SucceededPromptJobSchema = PromptJobBaseSchema.extend({
  status: z.literal('SUCCEEDED'),
  message: z.string().trim().min(1).max(1_000),
}).strict();

const FailedPromptJobSchema = PromptJobBaseSchema.extend({
  status: z.literal('FAILED'),
  errorCode: z.string().trim().min(1).max(64),
  message: z.string().trim().min(1).max(1_000),
  retryable: z.boolean(),
}).strict();

const CancelledPromptJobSchema = PromptJobBaseSchema.extend({
  status: z.literal('CANCELLED'),
  message: z.string().trim().min(1).max(1_000),
}).strict();

const AmbiguousPromptJobSchema = PromptJobBaseSchema.extend({
  status: z.literal('AMBIGUOUS'),
  errorCode: z.string().trim().min(1).max(64),
  message: z.string().trim().min(1).max(1_000),
  retryable: z.literal(false),
}).strict();

export const PromptGenerationJobSchema = z
  .discriminatedUnion('status', [
    PendingPromptJobSchema,
    SucceededPromptJobSchema,
    FailedPromptJobSchema,
    CancelledPromptJobSchema,
    AmbiguousPromptJobSchema,
  ])
  .superRefine(({ provider, credentialMode }, context) => {
    const result = ProviderAuthorizationSchema.safeParse({ provider, credentialMode });

    if (!result.success) {
      for (const issue of result.error.issues) {
        context.addIssue({ ...issue, path: issue.path });
      }
    }
  });
export type PromptGenerationJob = z.infer<typeof PromptGenerationJobSchema>;

export const PromptPreviewSchema = z
  .object({
    id: PublicIdSchema,
    promptVersionId: PublicIdSchema,
    status: PromptJobStatusSchema,
    content: z.string().trim().min(1).max(50_000),
    summary: z.string().trim().min(1).max(2_000),
    provider: LlmProviderSchema,
    model: z.string().trim().min(1).max(128),
    finishReason: z.string().trim().min(1).max(160).nullable(),
    latencyMs: z.number().int().nonnegative().max(3_600_000).nullable(),
    createdAt: PublicIsoDateTimeSchema,
    completedAt: PublicIsoDateTimeSchema.nullable(),
  })
  .strict();
export type PromptPreview = z.infer<typeof PromptPreviewSchema>;
