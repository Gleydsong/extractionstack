import type {
  InvestigationConfidence,
  InvestigationFinding,
  InvestigationReport,
} from '@extractionstack/shared';

const CONFIDENCE_LABELS: Record<InvestigationConfidence, string> = {
  confirmed: 'Confirmado',
  highly_probable: 'Altamente provável',
  probable: 'Provável',
  not_identified: 'Não identificado',
  not_applicable: 'Não aplicável',
};

export function InvestigationReportView({ report }: { report: InvestigationReport }): JSX.Element {
  const sections = Object.values(report.sections);
  return (
    <div className="investigation-report">
      <section aria-labelledby="executive-summary">
        <h2 id="executive-summary">1. Resumo executivo</h2>
        <p>{report.executiveSummary.systemOverview}</p>
        <p>{report.executiveSummary.constructionOverview}</p>
        <p>
          <strong>Confiança geral:</strong>{' '}
          {CONFIDENCE_LABELS[report.executiveSummary.overallConfidence]}
        </p>
        <p>
          <strong>Limitações:</strong>
        </p>
        <ul>
          {report.executiveSummary.limitations.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="technology-table">
        <h2 id="technology-table">2. Tabela geral de tecnologias</h2>
        {report.technologyTable.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Camada</th>
                  <th>Tecnologia</th>
                  <th>Função</th>
                  <th>Evidência</th>
                  <th>Confiança</th>
                </tr>
              </thead>
              <tbody>
                {report.technologyTable.map((item, index) => (
                  <tr key={`${item.category}-${item.name}-${index}`}>
                    <td>{item.category}</td>
                    <td>{item.name}</td>
                    <td>{item.probableFunction}</td>
                    <td>{item.evidence[0]?.snippet ?? 'Sem evidência conclusiva'}</td>
                    <td>{CONFIDENCE_LABELS[item.confidence]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>Nenhuma tecnologia pôde ser confirmada nesta captura.</p>
        )}
      </section>

      {sections.map((section, index) => (
        <section key={section.title} aria-labelledby={`investigation-section-${index}`}>
          <h2 id={`investigation-section-${index}`}>
            {index + 3}. {section.title}
          </h2>
          <p>{section.summary}</p>
          {section.findings.map((item, findingIndex) => (
            <Finding key={`${item.name}-${findingIndex}`} finding={item} />
          ))}
        </section>
      ))}

      <section aria-labelledby="architecture-diagram">
        <h2 id="architecture-diagram">12. Diagrama arquitetural</h2>
        <p className="meta">Mermaid gerado somente com componentes sustentados por evidências.</p>
        <pre>{report.diagramMermaid}</pre>
      </section>

      <section aria-labelledby="estimated-structure">
        <h2 id="estimated-structure">13. Estrutura estimada do projeto</h2>
        <p>{report.estimatedProjectStructure.disclaimer}</p>
        <pre>{report.estimatedProjectStructure.tree}</pre>
      </section>

      <section aria-labelledby="risks-limitations">
        <h2 id="risks-limitations">14. Riscos e limitações</h2>
        {report.risks.map((risk, index) => (
          <article className="finding" key={`${risk.title}-${index}`}>
            <h3>{risk.title}</h3>
            <p>
              <span className={`risk ${risk.severity}`}>{risk.severity}</span> {risk.description}
            </p>
            <p className="meta">Classificação: {risk.status}</p>
          </article>
        ))}
      </section>

      <section aria-labelledby="recommendations">
        <h2 id="recommendations">15. Recomendações</h2>
        {report.recommendations.map((item, index) => (
          <article className="finding" key={`${item.title}-${index}`}>
            <h3>{item.title}</h3>
            <p>{item.rationale}</p>
            <p className="meta">Prioridade: {item.priority}</p>
          </article>
        ))}
      </section>

      <section aria-labelledby="conclusion">
        <h2 id="conclusion">16. Conclusão</h2>
        <p>{report.conclusion}</p>
      </section>

      <section aria-labelledby="confidence-matrix">
        <h2 id="confidence-matrix">20. Matriz final de confiança</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Informação</th>
                <th>Resultado</th>
                <th>Confiança</th>
                <th>Justificativa</th>
              </tr>
            </thead>
            <tbody>
              {report.confidenceMatrix.map((item) => (
                <tr key={item.information}>
                  <td>{item.information}</td>
                  <td>
                    <code>{item.result}</code>
                  </td>
                  <td>{CONFIDENCE_LABELS[item.confidence]}</td>
                  <td>{item.justification}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="technical-evidence">
        <h2 id="technical-evidence">21. Evidências técnicas coletadas</h2>
        <p className="meta">
          Inventário bruto das evidências usadas para compor o relatório acima. Use esta seção para
          auditoria.
        </p>
        {Object.entries(report.technicalEvidence).map(([name, value]) => (
          <details key={name} className="finding">
            <summary>{humanizeEvidenceTitle(name)}</summary>
            <TechnicalEvidenceBody name={name} value={value} />
          </details>
        ))}
      </section>
    </div>
  );
}

const EVIDENCE_TITLES: Record<string, string> = {
  analyzedUrls: 'URLs analisadas',
  relevantHeaders: 'Cabeçalhos HTTP relevantes',
  scripts: 'Scripts carregados',
  stylesheets: 'Folhas de estilo carregadas',
  externalDomains: 'Domínios externos contactados',
  publicEndpoints: 'Endpoints públicos observados',
  cookies: 'Cookies (apenas nomes)',
  cssVariables: 'Variáveis CSS coletadas',
  fonts: 'Fontes detectadas',
  metadata: 'Metadados extraídos',
  manifests: 'Web manifests encontrados',
  serviceWorkers: 'Service workers detectados',
};

function humanizeEvidenceTitle(name: string): string {
  return EVIDENCE_TITLES[name] ?? name;
}

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string' && v.trim().length === 0) return true;
  if (Array.isArray(v) && v.length === 0) return true;
  if (typeof v === 'object' && Object.keys(v as object).length === 0) return true;
  return false;
}

function formatHeaderValue(v: unknown): string {
  if (v === null || v === undefined) return 'Não identificado';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map((x) => String(x)).join(', ');
  return JSON.stringify(v);
}

function TechnicalEvidenceBody({ name, value }: { name: string; value: unknown }): JSX.Element {
  if (isEmptyValue(value)) {
    return <p className="data-summary empty">Nenhuma informação coletada para esta categoria.</p>;
  }

  if (name === 'relevantHeaders' || name === 'metadata') {
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      <div className="data-summary">
        <p className="headline">
          {entries.length} {entries.length === 1 ? 'item identificado' : 'itens identificados'}.
        </p>
        {entries.map(([k, v]) => (
          <div className="row" key={k}>
            <div className="k">{k}</div>
            <div className="v">{formatHeaderValue(v)}</div>
          </div>
        ))}
      </div>
    );
  }

  if (Array.isArray(value)) {
    const list = value as unknown[];
    const preview = list.slice(0, 30);
    return (
      <div className="data-summary">
        <p className="headline">
          {list.length} {list.length === 1 ? 'item identificado' : 'itens identificados'}.
        </p>
        <div className="row">
          <div className="k">Lista</div>
          <div className="v">
            <div>
              {list.length > 30
                ? `Mostrando os primeiros 30 de ${list.length} itens.`
                : 'Todos os itens abaixo.'}
            </div>
            <div className="list" style={{ marginTop: 6 }}>
              {preview.map((item, i) => (
                <span className="chip" key={`${String(item)}-${i}`}>
                  {String(item)}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return <pre>{String(value)}</pre>;
}

function Finding({ finding }: { finding: InvestigationFinding }): JSX.Element {
  return (
    <details className="finding">
      <summary>
        <strong>{finding.name}</strong>{' '}
        <span className={`confidence ${finding.confidence}`}>
          {CONFIDENCE_LABELS[finding.confidence]}
        </span>
      </summary>
      <pre>{finding.result}</pre>
      <p>
        <strong>Função:</strong> {finding.probableFunction}
      </p>
      <p>
        <strong>Local:</strong> {finding.locations.join(', ')}
      </p>
      {finding.evidence.length ? (
        <>
          <p>
            <strong>Evidências:</strong>
          </p>
          <ul>
            {finding.evidence.map((item, index) => (
              <li key={`${item.source}-${index}`}>
                <code>
                  {item.source}: {item.snippet}
                </code>{' '}
                — {item.confidence}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {finding.limitations.length ? (
        <>
          <p>
            <strong>Limitações:</strong>
          </p>
          <ul>
            {finding.limitations.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      ) : null}
    </details>
  );
}
