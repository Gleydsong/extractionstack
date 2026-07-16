import { z } from 'zod';
import { EvidenceSchema, type Evidence } from './common.js';
import { InvestigationReportSchema } from './investigation.js';

export const DimensionSchema = z.enum([
  'cssFramework',
  'cssCustomization',
  'designSystem',
  'typography',
  'responsive',
  'gridSystem',
  'animation',
  'scrollAnimation',
  'transition',
  'seo',
  'performance',
  'componentArchitecture',
  'designTokens',
  'palette',
  'icons',
  'backendFramework',
  'language',
  'libraries',
  'stateManagement',
  'routing',
  'authProvider',
  'apisConsumed',
  'thirdPartyServices',
  'analytics',
  'cdn',
  'cloudProvider',
  'reverseProxy',
  'databaseIndicators',
  'dockerKubernetes',
  'architecture',
]);
export type Dimension = z.infer<typeof DimensionSchema>;

export const ExtractRequestSchema = z
  .object({
    url: z
      .string()
      .url({ message: 'must be a valid http(s) URL' })
      .max(2048)
      .refine((u) => /^https?:\/\//i.test(u), 'only http(s) URLs are allowed'),
  })
  .strict();
export type ExtractRequest = z.infer<typeof ExtractRequestSchema>;

export const NetworkEntrySchema = z.object({
  url: z.string(),
  method: z.string(),
  resourceType: z.string(),
  status: z.number().int().optional(),
  size: z.number().int().nonnegative().optional(),
  responseHeaders: z.record(z.string()).optional(),
  contentType: z.string().optional(),
  timing: z.number().optional(),
});
export type NetworkEntry = z.infer<typeof NetworkEntrySchema>;

export const CookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string().optional(),
  path: z.string().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.string().optional(),
});
export type Cookie = z.infer<typeof CookieSchema>;

export const CrawledPageSchema = z.object({
  finalUrl: z.string().url(),
  status: z.number().int().min(0).max(599),
  html: z.string(),
  headers: z.record(z.string()),
  responseHeaders: z.record(z.string()),
  networkLog: z.array(NetworkEntrySchema),
  cookies: z.array(CookieSchema).default([]),
  meta: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    canonical: z.string().optional(),
    robots: z.string().optional(),
    viewport: z.string().optional(),
    charset: z.string().optional(),
    htmlLang: z.string().optional(),
  }),
  scripts: z.array(
    z.object({
      src: z.string().optional(),
      type: z.string().optional(),
      content: z.string().optional(),
    }),
  ),
  stylesheets: z.array(
    z.object({
      href: z.string().optional(),
      content: z.string().optional(),
    }),
  ),
  linkRel: z.array(
    z.object({
      rel: z.string(),
      href: z.string(),
      as: z.string().optional(),
      type: z.string().optional(),
    }),
  ),
  computedStyles: z.array(
    z.object({
      selector: z.string(),
      styles: z.record(z.string()),
    }),
  ),
  perfTiming: z
    .object({
      navigationStart: z.number().optional(),
      domContentLoaded: z.number().optional(),
      load: z.number().optional(),
      firstPaint: z.number().optional(),
      firstContentfulPaint: z.number().optional(),
    })
    .optional(),
  fetchedAt: z.string().datetime(),
});
export type CrawledPage = z.infer<typeof CrawledPageSchema>;

export const DetectorResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      dimension: DimensionSchema,
      status: z.literal('ok'),
      data: z.unknown(),
      evidence: z.array(EvidenceSchema).max(100).optional(),
    })
    .strict(),
  z
    .object({
      dimension: DimensionSchema,
      status: z.literal('skipped'),
      reason: z.string().max(512),
    })
    .strict(),
  z
    .object({
      dimension: DimensionSchema,
      status: z.literal('error'),
      error: z.string().max(512),
    })
    .strict(),
]);

export type DetectorResult<T = unknown> =
  | { dimension: Dimension; status: 'ok'; data: T; evidence?: Evidence[] }
  | { dimension: Dimension; status: 'skipped'; reason: string }
  | { dimension: Dimension; status: 'error'; error: string };

export const ExtractionReportSchema = z.object({
  url: z.string().url(),
  finalUrl: z.string().url(),
  fetchedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
  sections: z.record(DetectorResultSchema),
  investigation: InvestigationReportSchema.optional(),
});
export type ExtractionReport = z.infer<typeof ExtractionReportSchema>;
