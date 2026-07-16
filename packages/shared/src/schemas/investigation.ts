import { z } from 'zod';
import { EvidenceSchema } from './common';

export const InvestigationConfidenceSchema = z.enum([
  'confirmed',
  'highly_probable',
  'probable',
  'not_identified',
  'not_applicable',
]);
export type InvestigationConfidence = z.infer<typeof InvestigationConfidenceSchema>;

export const InvestigationFindingSchema = z
  .object({
    name: z.string().min(1).max(160),
    category: z.string().min(1).max(120),
    result: z.string().min(1).max(8_000),
    locations: z.array(z.string().max(2_048)).max(30),
    confidence: InvestigationConfidenceSchema,
    probableFunction: z.string().max(1_000),
    limitations: z.array(z.string().max(1_000)).max(20),
    evidence: z.array(EvidenceSchema).max(100),
  })
  .strict();
export type InvestigationFinding = z.infer<typeof InvestigationFindingSchema>;

export const InvestigationSectionSchema = z
  .object({
    title: z.string().min(1).max(160),
    summary: z.string().min(1).max(4_000),
    findings: z.array(InvestigationFindingSchema).max(100),
  })
  .strict();

const RiskSchema = z
  .object({
    severity: z.enum(['critical', 'high', 'medium', 'low', 'informational']),
    status: z.enum(['confirmed_problem', 'potential_risk', 'not_identified', 'limitation']),
    title: z.string().max(200),
    description: z.string().max(2_000),
    evidence: z.array(EvidenceSchema).max(20),
  })
  .strict();

const RecommendationSchema = z
  .object({
    priority: z.enum(['critical', 'high', 'medium', 'low']),
    title: z.string().max(200),
    rationale: z.string().max(2_000),
  })
  .strict();

export const InvestigationReportSchema = z
  .object({
    executiveSummary: z
      .object({
        systemOverview: z.string().max(4_000),
        constructionOverview: z.string().max(4_000),
        mainTechnologies: z.array(z.string().max(160)).max(100),
        limitations: z.array(z.string().max(1_000)).max(30),
        overallConfidence: InvestigationConfidenceSchema,
        accessType: z.enum([
          'public_site',
          'public_site_devtools',
          'source_code',
          'git',
          'infrastructure',
        ]),
      })
      .strict(),
    technologyTable: z.array(InvestigationFindingSchema).max(200),
    sections: z
      .object({
        frontend: InvestigationSectionSchema,
        designSystem: InvestigationSectionSchema,
        backend: InvestigationSectionSchema,
        apisCommunication: InvestigationSectionSchema,
        authenticationSecurity: InvestigationSectionSchema,
        cmsContent: InvestigationSectionSchema,
        infrastructureDeploy: InvestigationSectionSchema,
        integrations: InvestigationSectionSchema,
        performanceAccessibility: InvestigationSectionSchema,
      })
      .strict(),
    diagramMermaid: z.string().max(12_000),
    estimatedProjectStructure: z
      .object({ disclaimer: z.string().max(1_000), tree: z.string().max(12_000) })
      .strict(),
    risks: z.array(RiskSchema).max(100),
    recommendations: z.array(RecommendationSchema).max(100),
    conclusion: z.string().max(4_000),
    confidenceMatrix: z
      .array(
        z
          .object({
            information: z.string().max(160),
            result: z.string().max(1_000),
            confidence: InvestigationConfidenceSchema,
            justification: z.string().max(2_000),
          })
          .strict(),
      )
      .max(100),
    technicalEvidence: z
      .object({
        analyzedUrls: z.array(z.string().url()).max(100),
        relevantHeaders: z.record(z.string().max(4_000)),
        scripts: z.array(z.string().max(2_048)).max(300),
        stylesheets: z.array(z.string().max(2_048)).max(300),
        externalDomains: z.array(z.string().max(255)).max(300),
        publicEndpoints: z.array(z.string().max(2_048)).max(300),
        cookies: z.array(z.string().max(1_000)).max(100),
        cssVariables: z.array(z.string().max(1_000)).max(300),
        fonts: z.array(z.string().max(1_000)).max(100),
        metadata: z.record(z.string().max(4_000)),
        manifests: z.array(z.string().max(2_048)).max(30),
        serviceWorkers: z.array(z.string().max(2_048)).max(30),
      })
      .strict(),
  })
  .strict();
export type InvestigationReport = z.infer<typeof InvestigationReportSchema>;
