import { useState } from 'react';
import type { DetectorResult, ExtractionReport } from '@extractionstack/shared';
import { ReportSection } from './ReportSection';
import { InvestigationReportView } from './InvestigationReportView';

interface ReportViewProps {
  report: ExtractionReport;
  url: string;
}

export function ReportView({ report, url }: ReportViewProps): JSX.Element {
  const sections = Object.values(report.sections) as DetectorResult[];
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (key: string): void => {
    const next = new Set(open);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setOpen(next);
  };

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Relatório</h2>
      <div className="meta">
        <div>URL solicitada: {url}</div>
        <div>URL final: {report.finalUrl}</div>
        <div>Coletado em: {new Date(report.fetchedAt).toLocaleString()}</div>
        <div>Duração: {report.durationMs}ms</div>
      </div>
      <div style={{ marginTop: 12 }}>
        {report.investigation ? (
          <>
            <InvestigationReportView report={report.investigation} />
            <details>
              <summary>Dados técnicos dos detectores</summary>
              {sections.map((s) => (
                <ReportSection
                  key={s.dimension}
                  section={s}
                  isOpen={open.has(s.dimension)}
                  onToggle={() => toggle(s.dimension)}
                />
              ))}
            </details>
          </>
        ) : (
          sections.map((s) => (
            <ReportSection
              key={s.dimension}
              section={s}
              isOpen={open.has(s.dimension)}
              onToggle={() => toggle(s.dimension)}
            />
          ))
        )}
      </div>
    </div>
  );
}
