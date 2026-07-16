import type {
  InvestigationConfidence,
  InvestigationFinding,
  InvestigationReport,
} from '@extractionstack/shared';
import {
  PromptSafetyService,
  SAFETY_REASON_CODES,
  type SafetyReasonCode,
} from '../safety/prompt-safety.service';

export type SafeSourceBrief = Readonly<{
  narrative: string;
  safetyReasonCodes: readonly SafetyReasonCode[];
  truncated: boolean;
}>;

export type ReportNarrativeAssemblerOptions = Readonly<{
  maxNarrativeChars?: number;
  maxSectionChars?: number;
}>;

const DEFAULT_MAX_NARRATIVE_CHARS = 24_000;
const DEFAULT_MAX_SECTION_CHARS = 4_000;
const TRUNCATION_MARKER = '[Seções adicionais omitidas por limite seguro]';

const CONFIDENCE_LABELS: Readonly<Record<InvestigationConfidence, string>> = {
  confirmed: 'confirmado',
  highly_probable: 'altamente provável',
  probable: 'provável',
  not_identified: 'não identificado',
  not_applicable: 'não aplicável',
};

const SECTION_KEYS = [
  'frontend',
  'designSystem',
  'backend',
  'apisCommunication',
  'authenticationSecurity',
  'cmsContent',
  'infrastructureDeploy',
  'integrations',
  'performanceAccessibility',
] as const;

export class ReportNarrativeAssembler {
  private readonly maxNarrativeChars: number;
  private readonly maxSectionChars: number;

  constructor(
    options: ReportNarrativeAssemblerOptions = {},
    private readonly safety = new PromptSafetyService(),
  ) {
    this.maxNarrativeChars = Math.max(
      options.maxNarrativeChars ?? DEFAULT_MAX_NARRATIVE_CHARS,
      256,
    );
    this.maxSectionChars = Math.max(options.maxSectionChars ?? DEFAULT_MAX_SECTION_CHARS, 256);
  }

  assemble(report: InvestigationReport): SafeSourceBrief {
    const reasons = new Set<SafetyReasonCode>();
    const clean = (value: string, maxChars = 1_000): string => {
      const bounded = boundText(value, maxChars);
      const inspected = this.safety.inspect(bounded);
      inspected.reasonCodes.forEach((reason) => reasons.add(reason));
      return inspected.safeText;
    };

    const blocks: string[] = [];
    const summary = report.executiveSummary;
    blocks.push(
      [
        '## Resumo executivo',
        `Visão do sistema: ${clean(summary.systemOverview, 1_200)}`,
        `Construção observada: ${clean(summary.constructionOverview, 1_200)}`,
        `Confiança geral: ${CONFIDENCE_LABELS[summary.overallConfidence]}`,
        `Tipo de acesso: ${summary.accessType}`,
        summary.mainTechnologies.length
          ? `Tecnologias principais: ${summary.mainTechnologies
              .slice(0, 30)
              .map((item) => clean(item, 160))
              .join(', ')}`
          : 'Tecnologias principais: não identificadas',
        ...summary.limitations.slice(0, 10).map((item) => `Limitação: ${clean(item, 500)}`),
      ].join('\n'),
    );

    if (report.technologyTable.length) {
      blocks.push(
        renderFindings(
          '## Tecnologias observadas',
          report.technologyTable,
          clean,
          this.maxSectionChars,
        ),
      );
    }

    for (const key of SECTION_KEYS) {
      const section = report.sections[key];
      const lines = [`## ${clean(section.title, 160)}`, clean(section.summary, 700)];
      for (const finding of section.findings.slice(0, 12)) {
        lines.push(renderFinding(finding, clean));
      }
      blocks.push(boundText(lines.join('\n'), this.maxSectionChars));
    }

    if (report.risks.length) {
      blocks.push(
        boundText(
          [
            '## Riscos',
            ...report.risks
              .slice(0, 20)
              .map(
                (risk) =>
                  `- [${risk.severity}; ${risk.status}] ${clean(risk.title, 200)}: ${clean(risk.description, 800)}`,
              ),
          ].join('\n'),
          this.maxSectionChars,
        ),
      );
    }

    if (report.recommendations.length) {
      blocks.push(
        boundText(
          [
            '## Recomendações',
            ...report.recommendations
              .slice(0, 20)
              .map(
                (item) =>
                  `- [${item.priority}] ${clean(item.title, 200)}: ${clean(item.rationale, 800)}`,
              ),
          ].join('\n'),
          this.maxSectionChars,
        ),
      );
    }

    blocks.push(`## Conclusão\n${clean(report.conclusion, 2_000)}`);

    if (report.confidenceMatrix.length) {
      blocks.push(
        boundText(
          [
            '## Matriz de confiança',
            ...report.confidenceMatrix.slice(0, 50).map((item) => {
              const information = clean(item.information, 160);
              const result = clean(item.result, 500);
              const confidence = CONFIDENCE_LABELS[item.confidence];
              const lead =
                item.confidence === 'not_identified'
                  ? `${information} não identificado`
                  : `${information}: ${result}`;
              return `- ${lead}. Confiança: ${confidence}. Justificativa: ${clean(item.justification, 700)}`;
            }),
          ].join('\n'),
          this.maxSectionChars,
        ),
      );
    }

    blocks.push(renderTechnicalEvidence(report, clean, this.maxSectionChars));

    const { narrative, truncated } = joinWholeBlocks(blocks, this.maxNarrativeChars);
    return Object.freeze({
      narrative,
      safetyReasonCodes: Object.freeze(SAFETY_REASON_CODES.filter((reason) => reasons.has(reason))),
      truncated,
    });
  }
}

type Cleaner = (value: string, maxChars?: number) => string;

function renderFindings(
  heading: string,
  findings: InvestigationFinding[],
  clean: Cleaner,
  maxChars: number,
): string {
  return boundText(
    [heading, ...findings.slice(0, 30).map((finding) => renderFinding(finding, clean))].join('\n'),
    maxChars,
  );
}

function renderFinding(finding: InvestigationFinding, clean: Cleaner): string {
  const result =
    finding.confidence === 'not_identified'
      ? `${clean(finding.name, 160)} não identificado`
      : `${clean(finding.name, 160)}: ${clean(finding.result, 700)}`;
  const lines = [
    `- ${result}. Confiança: ${CONFIDENCE_LABELS[finding.confidence]}.`,
    `  Função provável: ${clean(finding.probableFunction, 400)}`,
  ];
  if (finding.locations.length) {
    lines.push(
      `  Locais: ${finding.locations
        .slice(0, 8)
        .map((item) => clean(item, 300))
        .join(', ')}`,
    );
  }
  for (const evidence of finding.evidence.slice(0, 8)) {
    lines.push(
      `  Evidência [${evidence.source}; ${evidence.confidence}]: ${clean(evidence.snippet, 500)}`,
    );
  }
  for (const limitation of finding.limitations.slice(0, 5)) {
    lines.push(`  Limitação: ${clean(limitation, 400)}`);
  }
  return lines.join('\n');
}

function renderTechnicalEvidence(
  report: InvestigationReport,
  clean: Cleaner,
  maxChars: number,
): string {
  const evidence = report.technicalEvidence;
  const lines = ['## Evidências técnicas allowlisted'];
  for (const url of evidence.analyzedUrls.slice(0, 30)) lines.push(`- URL: ${clean(url, 500)}`);
  for (const [name, value] of Object.entries(evidence.relevantHeaders).slice(0, 30)) {
    lines.push(`- Header: ${clean(`${name}: ${value}`, 800)}`);
  }
  for (const endpoint of evidence.publicEndpoints.slice(0, 30)) {
    lines.push(`- Endpoint público: ${clean(endpoint, 500)}`);
  }
  for (const script of evidence.scripts.slice(0, 30)) lines.push(`- Script: ${clean(script, 500)}`);
  for (const domain of evidence.externalDomains.slice(0, 30)) {
    lines.push(`- Domínio externo: ${clean(domain, 255)}`);
  }
  for (const cookie of evidence.cookies.slice(0, 20)) {
    lines.push(`- Cookie observado: ${clean(`Cookie: ${cookie}`, 500)}`);
  }
  for (const [name, value] of Object.entries(evidence.metadata).slice(0, 30)) {
    lines.push(`- Metadado ${clean(name, 160)}: ${clean(value, 500)}`);
  }
  return boundText(lines.join('\n'), maxChars);
}

function boundText(value: string, maxChars: number): string {
  const normalized = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .trim();
  if (normalized.length <= maxChars) return normalized;
  const candidate = normalized.slice(0, Math.max(0, maxChars - 13));
  const boundary = Math.max(candidate.lastIndexOf('\n'), candidate.lastIndexOf(' '));
  return `${candidate.slice(0, boundary > maxChars / 2 ? boundary : candidate.length).trimEnd()} [truncado]`;
}

function joinWholeBlocks(
  blocks: readonly string[],
  maxChars: number,
): { narrative: string; truncated: boolean } {
  const accepted: string[] = [];
  const markerCost = TRUNCATION_MARKER.length + 2;
  let length = 0;
  let truncated = false;

  for (const block of blocks) {
    const separator = accepted.length ? 2 : 0;
    if (length + separator + block.length + markerCost > maxChars) {
      truncated = true;
      break;
    }
    accepted.push(block);
    length += separator + block.length;
  }

  if (truncated) accepted.push(TRUNCATION_MARKER);
  return { narrative: accepted.join('\n\n'), truncated };
}
