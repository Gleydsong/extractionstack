import { z } from 'zod';

export const ConfidenceSchema = z.enum(['high', 'medium', 'low']);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const EvidenceSourceSchema = z.enum([
  'html',
  'header',
  'script',
  'link',
  'meta',
  'network',
  'computedStyle',
  'cookie',
  'path',
]);
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

export const EvidenceSchema = z.object({
  source: EvidenceSourceSchema,
  snippet: z.string(),
  confidence: ConfidenceSchema,
  note: z.string().optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const ErrorResponseSchema = z.object({
  code: z.enum([
    'VALIDATION',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'CRAWLER_TIMEOUT',
    'CRAWLER_TARGET',
    'RATE_LIMITED',
    'INTERNAL',
  ]),
  message: z.string(),
  hint: z.string().optional(),
  fields: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .optional(),
  targetStatus: z.number().int().optional(),
  targetUrl: z.string().url().optional(),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
