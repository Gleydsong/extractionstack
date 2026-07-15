import { DetectorResult, Evidence } from '@extractionstack/shared';

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

export function ReportSection({ section, isOpen, onToggle }: Props): JSX.Element {
  const evidence = section.status === 'ok' ? section.evidence : undefined;
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
          {section.status === 'ok' ? (
            <>
              <pre style={{ marginBottom: 8 }}>{JSON.stringify(section.data, null, 2)}</pre>
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
                        {e.note ? <div className="meta" style={{ marginLeft: 0 }}>↳ {e.note}</div> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : (
            <pre>{JSON.stringify(section.reason ?? section.error, null, 2)}</pre>
          )}
        </>
      ) : null}
    </div>
  );
}
