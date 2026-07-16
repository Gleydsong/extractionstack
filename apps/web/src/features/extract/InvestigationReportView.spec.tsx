import { render, screen } from '@testing-library/react';
import type { InvestigationReport } from '@extractionstack/shared';
import { describe, expect, it } from 'vitest';
import { InvestigationReportView } from './InvestigationReportView';

const emptySection = { title: 'Arquitetura de frontend', summary: 'Resumo', findings: [] };
const report = {
  executiveSummary: {
    systemOverview: 'Sistema público analisado.',
    constructionOverview: 'Construção baseada em evidências.',
    mainTechnologies: [],
    limitations: ['Somente acesso público.'],
    overallConfidence: 'probable',
    accessType: 'public_site_devtools',
  },
  technologyTable: [],
  sections: {
    frontend: emptySection,
    designSystem: { ...emptySection, title: 'Design system' },
    backend: { ...emptySection, title: 'Arquitetura de backend' },
    apisCommunication: { ...emptySection, title: 'APIs e comunicação' },
    authenticationSecurity: { ...emptySection, title: 'Autenticação e segurança' },
    cmsContent: { ...emptySection, title: 'CMS e conteúdo' },
    infrastructureDeploy: { ...emptySection, title: 'Infraestrutura e deploy' },
    integrations: { ...emptySection, title: 'Integrações externas' },
    performanceAccessibility: { ...emptySection, title: 'Performance, SEO e acessibilidade' },
  },
  diagramMermaid: 'flowchart TD\nU --> FE',
  estimatedProjectStructure: { disclaimer: 'Estimativa.', tree: 'src/' },
  risks: [],
  recommendations: [],
  conclusion: 'Conclusão baseada nas evidências.',
  confidenceMatrix: [
    {
      information: 'CMS',
      result: 'Não identificado',
      confidence: 'not_identified',
      justification: 'Sem evidência.',
    },
  ],
  technicalEvidence: {
    analyzedUrls: ['https://example.com'],
    relevantHeaders: {},
    scripts: [],
    stylesheets: [],
    externalDomains: [],
    publicEndpoints: [],
    cookies: [],
    cssVariables: [],
    fonts: [],
    metadata: {},
    manifests: [],
    serviceWorkers: [],
  },
} as InvestigationReport;

describe('InvestigationReportView', () => {
  it('renders the mandatory report, confidence matrix, and technical evidence', () => {
    render(<InvestigationReportView report={report} />);
    expect(screen.getByRole('heading', { name: '1. Resumo executivo' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Arquitetura de frontend/ })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: '20. Matriz final de confiança' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: '21. Evidências técnicas coletadas' }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Não identificado')).toHaveLength(2);
  });
});
