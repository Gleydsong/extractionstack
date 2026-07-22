import type { DetectorResult, Evidence } from '@extractionstack/shared';
import { humanizeDetectorData, type HumanSummary } from './formatDetectorData';

interface Props {
  section: DetectorResult;
  isOpen: boolean;
  onToggle: () => void;
}

function confidenceColor(c: Evidence['confidence']): string {
  switch (c) {
    case 'high':
      return 'var(--ok)';
    case 'medium':
      return 'var(--warn)';
    case 'low':
      return 'var(--muted)';
  }
}

function terminalMessage(section: Exclude<DetectorResult, { status: 'ok' }>): string {
  return section.status === 'skipped' ? section.reason : section.error;
}

const TERMINAL_LABELS: Record<'skipped' | 'error', string> = {
  skipped: 'Este detector não foi aplicado nesta página.',
  error: 'Este detector encontrou um problema durante a análise.',
};

function SummaryGrid({ summary }: { summary: HumanSummary }): JSX.Element {
  if (summary.empty) {
    return <p className="data-summary empty">{summary.headline}</p>;
  }
  return (
    <div className="data-summary">
      <p className="headline">{summary.headline}</p>
      {summary.rows.map((row) => (
        <div className="row" key={row.key}>
          <div className="k">{row.key}</div>
          <div className="v">
            <div>{row.value}</div>
            {row.chips && row.chips.length > 0 ? (
              <div className="list" style={{ marginTop: 6 }}>
                {row.chips.map((chip, i) => (
                  <span className="chip" key={`${chip}-${i}`}>
                    {chip}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ReportSection({ section, isOpen, onToggle }: Props): JSX.Element {
  const evidence = section.status === 'ok' ? section.evidence : undefined;
  const summary =
    section.status === 'ok' ? humanizeDetectorData(section.dimension, section.data) : null;
  return (
    <div className="section">
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onToggle();
        }}
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}
      >
        <h3 style={{ flex: 1 }}>{section.dimension}</h3>
        {evidence && evidence.length > 0 ? (
          <span className="meta" style={{ marginRight: 8 }}>
            {evidence.length} evidência{evidence.length === 1 ? '' : 's'}
          </span>
        ) : null}
        <span className={`status ${section.status}`}>{section.status}</span>
        <span style={{ marginLeft: 8 }}>{isOpen ? '−' : '+'}</span>
      </div>
      {isOpen ? (
        <>
          {section.status === 'ok' && summary ? (
            <>
              <SummaryGrid summary={summary} />
              {evidence && evidence.length > 0 ? (
                <div>
                  <div
                    className="meta"
                    style={{ marginBottom: 4, fontWeight: 600, color: 'var(--fg)' }}
                  >
                    Evidências
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.85rem' }}>
                    {evidence.map((e, i) => (
                      <li key={i} style={{ marginBottom: 4 }}>
                        <span
                          style={{
                            color: confidenceColor(e.confidence),
                            fontWeight: 600,
                            marginRight: 6,
                          }}
                        >
                          [{e.confidence}]
                        </span>
                        <span className="meta" style={{ marginRight: 6 }}>
                          ({e.source})
                        </span>
                        <code style={{ wordBreak: 'break-all' }}>{e.snippet}</code>
                        {e.note ? (
                          <div className="meta" style={{ marginLeft: 0 }}>
                            ↳ {e.note}
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : (
            <div className="data-summary">
              <p className="headline">
                {section.status === 'ok'
                  ? ''
                  : TERMINAL_LABELS[section.status as 'skipped' | 'error']}
              </p>
              <div className="row">
                <div className="k">{section.status === 'skipped' ? 'Motivo' : 'Erro'}</div>
                <div className="v">
                  {terminalMessage(section as Exclude<DetectorResult, { status: 'ok' }>)}
                </div>
              </div>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
