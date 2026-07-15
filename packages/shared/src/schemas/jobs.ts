import { z } from 'zod';
import { ExtractionReportSchema } from './extract';

export const ExtractionStatusSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCEL_REQUESTED',
  'CANCELLED',
]);
export type ExtractionStatus = z.infer<typeof ExtractionStatusSchema>;

export const IdempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'invalid idempotency key');

export const ExtractionIdSchema = z
  .string()
  .min(10)
  .max(64)
  .regex(/^c[a-z0-9]+$/i, 'invalid extraction id');

export const CreateExtractionSchema = z
  .object({
    url: z
      .string()
      .url({ message: 'must be a valid http(s) URL' })
      .max(2048)
      .refine((url) => /^https?:\/\//i.test(url), 'only http(s) URLs are allowed'),
  })
  .strict();
export type CreateExtraction = z.infer<typeof CreateExtractionSchema>;

export const ExtractionJobSchema = z
  .object({
    id: ExtractionIdSchema,
    requestedUrl: z.string().url().max(2048),
    normalizedUrl: z.string().url().max(2048),
    status: ExtractionStatusSchema,
    attempts: z.number().int().nonnegative(),
    maxAttempts: z.number().int().min(1).max(10),
    errorCode: z.string().max(64).nullable().optional(),
    errorMessage: z.string().max(512).nullable().optional(),
    queuedAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable().optional(),
    finishedAt: z.string().datetime().nullable().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    report: ExtractionReportSchema.optional(),
  })
  .strict();
export type ExtractionJob = z.infer<typeof ExtractionJobSchema>;

export const ExtractionListQuerySchema = z
  .object({
    cursor: z.string().min(1).max(256).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: ExtractionStatusSchema.optional(),
    sort: z.enum(['createdAt:asc', 'createdAt:desc']).default('createdAt:desc'),
  })
  .strict();
export type ExtractionListQuery = z.infer<typeof ExtractionListQuerySchema>;

export const ExtractionListResponseSchema = z
  .object({
    items: z.array(ExtractionJobSchema),
    nextCursor: z.string().max(256).nullable(),
  })
  .strict();
export type ExtractionListResponse = z.infer<typeof ExtractionListResponseSchema>;
