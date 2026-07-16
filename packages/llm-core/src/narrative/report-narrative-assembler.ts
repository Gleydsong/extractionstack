import type {
  InvestigationConfidence,
  InvestigationFinding,
  InvestigationReport,
} from '@extractionstack/shared';
import {
  PromptSafetyService,
  SAFETY_REASON_CODES,
  type SafetyInspection,
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
const MAX_NARRATIVE_CHARS = 100_000;
const MAX_SECTION_CHARS = 20_000;
const OVERALL_OMISSION_MARKER = '[Seções adicionais omitidas por limite seguro]';
const SECTION_OMISSION_MARKER = '[Entradas adicionais omitidas por limite seguro]';
const VALUE_OMISSION_MARKER = '[Conteúdo omitido por limite seguro]';

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

type Cleaner = (value: string, maxChars?: number) => string;
type SectionRender = Readonly<{ text: string; truncated: boolean }>;

export class ReportNarrativeAssembler {
  private readonly maxNarrativeChars: number;
  private readonly maxSectionChars: number;

  constructor(
    options: ReportNarrativeAssemblerOptions = {},
    private readonly safety = new PromptSafetyService(),
  ) {
    this.maxNarrativeChars = validateLimit(
      options.maxNarrativeChars,
      DEFAULT_MAX_NARRATIVE_CHARS,
      MAX_NARRATIVE_CHARS,
    );
    this.maxSectionChars = validateLimit(
      options.maxSectionChars,
      DEFAULT_MAX_SECTION_CHARS,
      MAX_SECTION_CHARS,
    );
  }

  assemble(report: InvestigationReport): SafeSourceBrief {
    const reasons = new Set<SafetyReasonCode>();
    const useInspection = (result: SafetyInspection, maxChars: number): string => {
      result.reasonCodes.forEach((reason) => reasons.add(reason));
      return boundWholeValue(result.safeText, maxChars);
    };
    const clean: Cleaner = (value, maxChars = 1_000) => {
      if (normalizeText(value).length > maxChars) return VALUE_OMISSION_MARKER;
      return useInspection(this.safety.inspect(value), maxChars);
    };
    const cleanUrl = (value: string, maxChars = 2_048): string =>
      useInspection(this.safety.inspectUrl(value), maxChars);
    const cleanHeader = (name: string, value: string): string =>
      useInspection(this.safety.inspectHeader(name, value), 4_200);

    const blocks: string[] = [];
    let sectionTruncated = false;
    const addSection = (section: SectionRender): void => {
      if (section.text) blocks.push(section.text);
      sectionTruncated ||= section.truncated;
    };

    const summary = report.executiveSummary;
    addSection(
      renderBoundedSection(
        '## Resumo executivo',
        [
          `Visão do sistema: ${clean(summary.systemOverview, 4_000)}`,
          `Construção observada: ${clean(summary.constructionOverview, 4_000)}`,
          `Confiança geral: ${CONFIDENCE_LABELS[summary.overallConfidence]}`,
          `Tipo de acesso: ${summary.accessType}`,
          summary.mainTechnologies.length
            ? `Tecnologias principais: ${summary.mainTechnologies
                .slice(0, 30)
                .map((item) => clean(item, 160))
                .join(', ')}`
            : 'Tecnologias principais: não identificadas',
          ...summary.limitations.slice(0, 30).map((item) => `Limitação: ${clean(item, 1_000)}`),
        ],
        this.maxSectionChars,
        summary.mainTechnologies.length > 30 || summary.limitations.length > 30,
      ),
    );

    if (report.technologyTable.length) {
      addSection(
        renderBoundedSection(
          '## Tecnologias observadas',
          report.technologyTable.slice(0, 30).map((finding) => renderFinding(finding, clean)),
          this.maxSectionChars,
          report.technologyTable.length > 30,
        ),
      );
    }

    for (const key of SECTION_KEYS) {
      const section = report.sections[key];
      addSection(
        renderBoundedSection(
          `## ${clean(section.title, 160)}`,
          [
            clean(section.summary, 4_000),
            ...section.findings.slice(0, 100).map((finding) => renderFinding(finding, clean)),
          ],
          this.maxSectionChars,
          section.findings.length > 100,
        ),
      );
    }

    if (report.risks.length) {
      addSection(
        renderBoundedSection(
          '## Riscos',
          report.risks
            .slice(0, 100)
            .map(
              (risk) =>
                `- [${risk.severity}; ${risk.status}] ${clean(risk.title, 200)}: ${clean(risk.description, 2_000)}`,
            ),
          this.maxSectionChars,
          report.risks.length > 100,
        ),
      );
    }

    if (report.recommendations.length) {
      addSection(
        renderBoundedSection(
          '## Recomendações',
          report.recommendations
            .slice(0, 100)
            .map(
              (item) =>
                `- [${item.priority}] ${clean(item.title, 200)}: ${clean(item.rationale, 2_000)}`,
            ),
          this.maxSectionChars,
          report.recommendations.length > 100,
        ),
      );
    }

    addSection(
      renderBoundedSection('## Conclusão', [clean(report.conclusion, 4_000)], this.maxSectionChars),
    );

    if (report.confidenceMatrix.length) {
      addSection(
        renderBoundedSection(
          '## Matriz de confiança',
          report.confidenceMatrix.slice(0, 100).map((item) => {
            const information = clean(item.information, 160);
            const result = clean(item.result, 1_000);
            const confidence = CONFIDENCE_LABELS[item.confidence];
            const lead =
              item.confidence === 'not_identified'
                ? `${information} não identificado`
                : `${information}: ${result}`;
            return `- ${lead}. Confiança: ${confidence}. Justificativa: ${clean(item.justification, 2_000)}`;
          }),
          this.maxSectionChars,
          report.confidenceMatrix.length > 100,
        ),
      );
    }

    const technicalEntries: string[] = [];
    const evidence = report.technicalEvidence;
    for (const url of evidence.analyzedUrls.slice(0, 100)) {
      technicalEntries.push(`- URL: ${cleanUrl(url)}`);
    }
    for (const [name, value] of Object.entries(evidence.relevantHeaders).slice(0, 100)) {
      technicalEntries.push(`- Header: ${cleanHeader(name, value)}`);
    }
    for (const endpoint of evidence.publicEndpoints.slice(0, 100)) {
      technicalEntries.push(`- Endpoint público: ${cleanUrl(endpoint)}`);
    }
    for (const script of evidence.scripts.slice(0, 100)) {
      technicalEntries.push(`- Script: ${cleanUrl(script)}`);
    }
    for (const domain of evidence.externalDomains.slice(0, 100)) {
      technicalEntries.push(`- Domínio externo: ${clean(domain, 255)}`);
    }
    for (const cookie of evidence.cookies.slice(0, 100)) {
      technicalEntries.push(`- Cookie observado: ${cleanHeader('Cookie', cookie)}`);
    }
    for (const [name, value] of Object.entries(evidence.metadata).slice(0, 100)) {
      technicalEntries.push(`- Metadado ${clean(name, 160)}: ${clean(value, 4_000)}`);
    }
    addSection(
      renderBoundedSection(
        '## Evidências técnicas allowlisted',
        technicalEntries,
        this.maxSectionChars,
        hasAdditionalTechnicalEvidence(report),
      ),
    );

    const overall = joinWholeBlocks(blocks, this.maxNarrativeChars);
    return Object.freeze({
      narrative: overall.text,
      safetyReasonCodes: Object.freeze(SAFETY_REASON_CODES.filter((reason) => reasons.has(reason))),
      truncated: sectionTruncated || overall.truncated,
    });
  }
}

function renderFinding(finding: InvestigationFinding, clean: Cleaner): string {
  const result =
    finding.confidence === 'not_identified'
      ? `${clean(finding.name, 160)} não identificado`
      : `${clean(finding.name, 160)}: ${clean(finding.result, 8_000)}`;
  const lines = [
    `- ${result}. Confiança: ${CONFIDENCE_LABELS[finding.confidence]}.`,
    `  Função provável: ${clean(finding.probableFunction, 1_000)}`,
  ];
  if (finding.locations.length) {
    lines.push(`  Locais: ${finding.locations.map((item) => clean(item, 2_048)).join(', ')}`);
  }
  for (const evidence of finding.evidence) {
    lines.push(
      `  Evidência [${evidence.source}; ${evidence.confidence}]: ${clean(evidence.snippet, 8_000)}`,
    );
  }
  for (const limitation of finding.limitations) {
    lines.push(`  Limitação: ${clean(limitation, 1_000)}`);
  }
  return lines.join('\n');
}

function renderBoundedSection(
  heading: string,
  entries: readonly string[],
  maxChars: number,
  preTruncated = false,
): SectionRender {
  if (heading.length > maxChars) {
    return {
      text: SECTION_OMISSION_MARKER.length <= maxChars ? SECTION_OMISSION_MARKER : '',
      truncated: true,
    };
  }

  const accepted = [heading];
  let length = heading.length;
  let truncated = preTruncated;
  for (const entry of entries) {
    const entryCost = entry.length + 1;
    const markerCost = SECTION_OMISSION_MARKER.length + 1;
    if (length + entryCost + markerCost <= maxChars) {
      accepted.push(entry);
      length += entryCost;
    } else {
      truncated = true;
    }
  }

  if (truncated) {
    while (
      accepted.length > 1 &&
      accepted.join('\n').length + SECTION_OMISSION_MARKER.length + 1 > maxChars
    ) {
      accepted.pop();
    }
    if (accepted.join('\n').length + SECTION_OMISSION_MARKER.length + 1 <= maxChars) {
      accepted.push(SECTION_OMISSION_MARKER);
    } else if (SECTION_OMISSION_MARKER.length <= maxChars) {
      return { text: SECTION_OMISSION_MARKER, truncated: true };
    } else {
      return { text: '', truncated: true };
    }
  }

  return { text: accepted.join('\n'), truncated };
}

function joinWholeBlocks(blocks: readonly string[], maxChars: number): SectionRender {
  const accepted: string[] = [];
  let length = 0;
  let truncated = false;
  for (const block of blocks) {
    const separator = accepted.length ? 2 : 0;
    const markerCost = OVERALL_OMISSION_MARKER.length + (accepted.length ? 2 : 0);
    if (length + separator + block.length + markerCost <= maxChars) {
      accepted.push(block);
      length += separator + block.length;
    } else {
      truncated = true;
      break;
    }
  }
  if (truncated) {
    if (length + (accepted.length ? 2 : 0) + OVERALL_OMISSION_MARKER.length <= maxChars) {
      accepted.push(OVERALL_OMISSION_MARKER);
    } else if (!accepted.length && OVERALL_OMISSION_MARKER.length <= maxChars) {
      accepted.push(OVERALL_OMISSION_MARKER);
    }
  }
  return { text: accepted.join('\n\n'), truncated };
}

function boundWholeValue(value: string, maxChars: number): string {
  const normalized = normalizeText(value);
  return normalized.length <= maxChars ? normalized : VALUE_OMISSION_MARKER;
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .trim();
}

function validateLimit(value: number | undefined, fallback: number, maximum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new Error('INVALID_ASSEMBLER_OPTIONS');
  }
  return resolved;
}

function hasAdditionalTechnicalEvidence(report: InvestigationReport): boolean {
  const evidence = report.technicalEvidence;
  return (
    evidence.analyzedUrls.length > 100 ||
    Object.keys(evidence.relevantHeaders).length > 100 ||
    evidence.publicEndpoints.length > 100 ||
    evidence.scripts.length > 100 ||
    evidence.externalDomains.length > 100 ||
    evidence.cookies.length > 100 ||
    Object.keys(evidence.metadata).length > 100
  );
}
