import {
  InvestigationReportSchema,
  type CrawledPage,
  type DetectorResult,
  type Evidence,
  type InvestigationConfidence,
  type InvestigationFinding,
  type InvestigationReport,
} from '@extractionstack/shared';

const LABELS: Record<string, string> = {
  cssFramework: 'Framework CSS',
  cssCustomization: 'Estratégia de estilização',
  designSystem: 'Biblioteca ou design system',
  typography: 'Tipografia',
  responsive: 'Responsividade e grid',
  animation: 'Animações',
  scrollAnimation: 'Animações por scroll',
  transition: 'Transições',
  seo: 'SEO e metadados',
  performance: 'Performance observável',
  componentArchitecture: 'Componentização observável',
  designTokens: 'Tokens visuais',
  palette: 'Paleta de cores',
  icons: 'Ícones',
  backendFramework: 'Tecnologia de servidor',
  language: 'Linguagens detectáveis',
  libraries: 'Bibliotecas de frontend',
  stateManagement: 'Gerenciamento de estado',
  routing: 'Roteamento',
  authProvider: 'Autenticação',
  apisConsumed: 'APIs consumidas',
  thirdPartyServices: 'Serviços externos',
  analytics: 'Analytics',
  cdn: 'CDN',
  cloudProvider: 'Hospedagem/cloud',
  reverseProxy: 'Proxy reverso',
  databaseIndicators: 'Banco de dados',
  dockerKubernetes: 'Containers e orquestração',
  architecture: 'Arquitetura e renderização',
};

const FUNCTION_BY_DIMENSION: Record<string, string> = {
  cssFramework: 'Composição visual e utilitários de estilo.',
  designSystem: 'Padronização de componentes e identidade visual.',
  stateManagement: 'Coordenação do estado da interface.',
  routing: 'Navegação e resolução de rotas no cliente ou servidor.',
  authProvider: 'Identidade, autenticação e sessão do usuário.',
  apisConsumed: 'Comunicação da interface com serviços HTTP.',
  analytics: 'Medição de uso e comportamento.',
  cdn: 'Entrega e cache de conteúdo na borda.',
  databaseIndicators: 'Persistência de dados do sistema.',
  architecture: 'Estratégia de renderização e distribuição do sistema.',
};

export function buildInvestigationReport(
  page: CrawledPage,
  detectorResults: DetectorResult[],
  requestedUrl: string,
): InvestigationReport {
  const byDimension = new Map(detectorResults.map((result) => [result.dimension, result]));
  const findings = detectorResults.map((result) => detectorFinding(result, page.finalUrl));
  const accessibility = accessibilityFinding(page);
  const security = securityFinding(page);
  const pwa = pwaFinding(page);
  const media = mediaFinding(page);
  const cms = cmsFinding(page);
  const publicApis = publicApiFinding(page);

  const frontend = select(findings, [
    'cssFramework',
    'cssCustomization',
    'language',
    'libraries',
    'stateManagement',
    'routing',
    'componentArchitecture',
    'architecture',
  ]).concat(pwa, media);
  const designSystem = select(findings, [
    'designSystem',
    'typography',
    'responsive',
    'animation',
    'scrollAnimation',
    'transition',
    'designTokens',
    'palette',
    'icons',
  ]);
  const backend = select(findings, [
    'backendFramework',
    'databaseIndicators',
    'dockerKubernetes',
    'reverseProxy',
    'architecture',
  ]);
  const apis = select(findings, ['apisConsumed', 'architecture']).concat(publicApis);
  const authSecurity = select(findings, ['authProvider']).concat(security);
  const infrastructure = select(findings, [
    'cdn',
    'cloudProvider',
    'reverseProxy',
    'dockerKubernetes',
  ]);
  const integrations = select(findings, ['thirdPartyServices', 'analytics']);
  const performanceAccessibility = select(findings, ['performance', 'seo']).concat(
    accessibility,
    media,
  );

  const technologyTable = detectorResults.flatMap((result) =>
    technologyFindings(result, page.finalUrl),
  );
  const confirmedTechnologyNames = technologyTable
    .filter((item) => item.confidence !== 'not_identified')
    .map((item) => item.name);
  const risks = buildRisks(page, accessibility, security);
  const recommendations = buildRecommendations(risks, byDimension);
  const technicalEvidence = collectTechnicalEvidence(page, requestedUrl, byDimension);
  const overallConfidence = confirmedTechnologyNames.length > 0 ? 'highly_probable' : 'probable';

  return InvestigationReportSchema.parse({
    executiveSummary: {
      systemOverview: summarizeSystem(page),
      constructionOverview:
        confirmedTechnologyNames.length > 0
          ? `A implementação apresenta evidências de ${confirmedTechnologyNames.slice(0, 8).join(', ')}. Itens sem evidência permanecem explicitamente não identificados.`
          : 'A página foi observada em runtime, mas não expôs assinaturas suficientes para confirmar as tecnologias principais.',
      mainTechnologies: unique(confirmedTechnologyNames).slice(0, 30),
      limitations: [
        'Análise passiva de uma única URL pública; áreas autenticadas e rotas não navegadas não foram inspecionadas.',
        'Bundles transpilados/minificados podem ocultar linguagem, nomes internos e arquitetura do código-fonte.',
        'Ausência de evidência pública não prova ausência de uma tecnologia no backend ou infraestrutura.',
      ],
      overallConfidence,
      accessType: 'public_site_devtools',
    },
    technologyTable,
    sections: {
      frontend: section('Arquitetura de frontend', frontend),
      designSystem: section('Design system', designSystem),
      backend: section('Arquitetura de backend', backend),
      apisCommunication: section('APIs e comunicação', apis),
      authenticationSecurity: section('Autenticação e segurança', authSecurity),
      cmsContent: section('CMS e conteúdo', [cms]),
      infrastructureDeploy: section('Infraestrutura e deploy', infrastructure),
      integrations: section('Integrações externas', integrations),
      performanceAccessibility: section(
        'Performance, SEO e acessibilidade',
        performanceAccessibility,
      ),
    },
    diagramMermaid: buildDiagram(byDimension, page),
    estimatedProjectStructure: {
      disclaimer:
        'Proposta de reconstrução baseada nas evidências públicas; não representa nomes ou pastas reais do sistema analisado.',
      tree: estimatedStructure(byDimension),
    },
    risks,
    recommendations,
    conclusion: `A análise confirma somente sinais sustentados pelas ${detectorResults.reduce((total, result) => total + (result.status === 'ok' ? (result.evidence?.length ?? 0) : 0), 0)} evidências coletadas. Tecnologias de servidor, banco, CMS e infraestrutura permanecem não identificadas quando o site público não as expõe.`,
    confidenceMatrix: buildConfidenceMatrix(byDimension, cms),
    technicalEvidence,
  });
}

function detectorFinding(result: DetectorResult, finalUrl: string): InvestigationFinding {
  if (result.status !== 'ok') {
    return finding(
      LABELS[result.dimension] ?? result.dimension,
      result.dimension,
      result.status === 'skipped' ? result.reason : 'A análise desta dimensão falhou.',
      'not_identified',
      [],
      [finalUrl],
      'Não foi possível determinar a função nesta dimensão.',
      ['Sem evidência pública suficiente.'],
    );
  }
  const evidence = result.evidence ?? [];
  const confidence = confidenceFor(result);
  return finding(
    LABELS[result.dimension] ?? result.dimension,
    result.dimension,
    safeJson(result.data),
    confidence,
    evidence,
    evidence.length ? unique(evidence.map((item) => `${item.source}: ${finalUrl}`)) : [finalUrl],
    FUNCTION_BY_DIMENSION[result.dimension] ??
      'Caracterização técnica desta dimensão da aplicação.',
    confidence === 'not_identified'
      ? ['Nenhuma assinatura pública conclusiva foi encontrada.']
      : ['A conclusão é limitada à página e aos recursos observados nesta execução.'],
  );
}

function technologyFindings(result: DetectorResult, finalUrl: string): InvestigationFinding[] {
  if (result.status !== 'ok' || !result.data || typeof result.data !== 'object') return [];
  const names = detectedTechnologyNames(result);
  return names.map((name) =>
    (() => {
      const evidence = evidenceForTechnology(name, result.evidence ?? [], names.length);
      return finding(
        name,
        LABELS[result.dimension] ?? result.dimension,
        `Tecnologia identificada na dimensão ${LABELS[result.dimension] ?? result.dimension}.`,
        confidenceFromEvidence(evidence, true),
        evidence,
        [finalUrl],
        FUNCTION_BY_DIMENSION[result.dimension] ?? 'Função indicada pela categoria detectada.',
        [
          'Assinaturas públicas podem permanecer em bundles mesmo após migrações; confirme no código quando disponível.',
        ],
      );
    })(),
  );
}

function detectedTechnologyNames(result: DetectorResult): string[] {
  if (result.status !== 'ok' || !result.data || typeof result.data !== 'object') return [];
  const data = result.data as Record<string, unknown>;
  const raw = Array.isArray(data.detected)
    ? data.detected
    : typeof data.primary === 'string' && data.primary
      ? [data.primary]
      : [];
  return unique(
    raw
    .map((value) =>
      typeof value === 'string'
        ? value
        : value &&
            typeof value === 'object' &&
            typeof (value as { name?: unknown }).name === 'string'
          ? (value as { name: string }).name
          : null,
    )
      .filter((value): value is string => Boolean(value)),
  );
}

function evidenceForTechnology(
  technology: string,
  evidence: Evidence[],
  detectedTechnologyCount: number,
): Evidence[] {
  const normalized = technology.toLowerCase();
  const matching = evidence.filter((item) =>
    `${item.snippet} ${item.note ?? ''}`.toLowerCase().includes(normalized),
  );
  return matching.length > 0 || detectedTechnologyCount > 1 ? matching : evidence;
}

function accessibilityFinding(page: CrawledPage): InvestigationFinding {
  const images = page.html.match(/<img\b[^>]*>/gi) ?? [];
  const missingAlt = images.filter((tag) => !/\balt\s*=/i.test(tag)).length;
  const headings = Array.from(page.html.matchAll(/<h([1-6])\b/gi), (match) => Number(match[1]));
  const skippedHeading = headings.some(
    (level, index) => index > 0 && level - (headings[index - 1] ?? level) > 1,
  );
  const evidence: Evidence[] = [
    { source: 'html', snippet: `lang=${page.meta.htmlLang ?? 'ausente'}`, confidence: 'high' },
    {
      source: 'html',
      snippet: `${images.length} imagem(ns), ${missingAlt} sem atributo alt`,
      confidence: 'high',
    },
    {
      source: 'html',
      snippet: `sequência de headings: ${headings.join(', ') || 'não encontrada'}`,
      confidence: 'high',
    },
  ];
  return finding(
    'Auditoria estrutural de acessibilidade',
    'Acessibilidade',
    safeJson({
      htmlLanguage: page.meta.htmlLang ?? null,
      images: images.length,
      imagesMissingAlt: missingAlt,
      headingLevels: headings,
      skippedHeading,
    }),
    'confirmed',
    evidence,
    [page.finalUrl],
    'Avaliar sinais estáticos de semântica, idioma, headings e texto alternativo.',
    [
      'Contraste, teclado, foco, nomes acessíveis e leitores de tela exigem auditoria interativa adicional.',
    ],
  );
}

function securityFinding(page: CrawledPage): InvestigationFinding {
  const names = [
    'strict-transport-security',
    'content-security-policy',
    'x-content-type-options',
    'referrer-policy',
    'permissions-policy',
    'x-frame-options',
  ];
  const observed = Object.fromEntries(names.map((name) => [name, page.headers[name] ?? null]));
  const evidence = names
    .filter((name) => page.headers[name])
    .map<Evidence>((name) => ({
      source: 'header',
      snippet: `${name}: ${page.headers[name]}`,
      confidence: 'high',
    }));
  return finding(
    'Headers e cookies de segurança observáveis',
    'Segurança',
    safeJson({
      https: page.finalUrl.startsWith('https:'),
      headers: observed,
      cookies: page.cookies.map((cookie) => ({
        name: cookie.name,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
      })),
    }),
    'confirmed',
    evidence,
    [page.finalUrl],
    'Avaliar controles defensivos expostos na resposta pública.',
    [
      'Ausência em uma resposta não confirma vulnerabilidade; políticas podem ser aplicadas por outras camadas ou rotas.',
    ],
  );
}

function pwaFinding(page: CrawledPage): InvestigationFinding {
  const manifests = page.linkRel.filter((link) => link.rel.toLowerCase().includes('manifest'));
  const serviceWorkers = page.scripts
    .flatMap((script) =>
      [script.src, script.content].filter((value): value is string => Boolean(value)),
    )
    .filter((value) => /serviceWorker|service-worker|sw\.js/i.test(value));
  const storage = unique(
    Array.from(
      page.html.matchAll(/\b(localStorage|sessionStorage|indexedDB)\b/g),
      (match) => match[1] ?? '',
    ),
  );
  const evidence: Evidence[] = [
    ...manifests.map((manifest) => ({
      source: 'link' as const,
      snippet: manifest.href,
      confidence: 'high' as const,
    })),
    ...serviceWorkers
      .slice(0, 5)
      .map((value) => ({
        source: 'script' as const,
        snippet: value.slice(0, 300),
        confidence: 'medium' as const,
      })),
  ];
  return finding(
    'PWA e recursos do navegador',
    'Frontend',
    safeJson({
      manifests: manifests.map((item) => item.href),
      serviceWorkerSignals: serviceWorkers.length,
      storage,
    }),
    evidence.length ? 'confirmed' : 'not_identified',
    evidence,
    [page.finalUrl],
    'Identificar instalação, offline e armazenamento observável.',
    ['Service workers podem ser registrados depois da interação e não aparecer nesta captura.'],
  );
}

function mediaFinding(page: CrawledPage): InvestigationFinding {
  const sources = Array.from(
    page.html.matchAll(/<(?:img|source|video)[^>]+(?:src|srcset)=["']([^"']+)/gi),
    (match) => match[1] ?? '',
  );
  const formats = unique(
    sources
      .map((source) => source.match(/\.([a-z0-9]+)(?:\?|$)/i)?.[1]?.toLowerCase())
      .filter((value): value is string => Boolean(value)),
  );
  const lazy = (page.html.match(/\bloading=["']lazy["']/gi) ?? []).length;
  return finding(
    'Imagens, vídeos e mídia',
    'Mídia',
    safeJson({
      resources: sources.length,
      formats,
      lazyLoaded: lazy,
      responsiveImages: (page.html.match(/\bsrcset=/gi) ?? []).length,
      videos: (page.html.match(/<video\b/gi) ?? []).length,
    }),
    sources.length ? 'confirmed' : 'not_identified',
    sources.slice(0, 10).map((source) => ({ source: 'html', snippet: source, confidence: 'high' })),
    [page.finalUrl],
    'Entrega e otimização de recursos visuais.',
    ['Recursos carregados após interação podem não aparecer nesta navegação.'],
  );
}

function cmsFinding(page: CrawledPage): InvestigationFinding {
  const signatures = [
    ['WordPress', /\/wp-content\/|\/wp-json\//i],
    ['Shopify', /cdn\.shopify\.com|Shopify\.theme/i],
    ['Webflow', /data-wf-site|webflow\.com/i],
    ['Sanity', /cdn\.sanity\.io/i],
    ['Contentful', /images\.ctfassets\.net/i],
    ['Storyblok', /api\.storyblok\.com/i],
  ] as const;
  const match = signatures.find(
    ([, pattern]) =>
      pattern.test(page.html) || page.networkLog.some((entry) => pattern.test(entry.url)),
  );
  return finding(
    match?.[0] ?? 'CMS',
    'CMS e conteúdo',
    match
      ? `${match[0]} apresentou assinatura pública direta.`
      : 'CMS não identificado; não é tecnicamente confiável inferi-lo apenas pelo conteúdo observado.',
    match ? 'confirmed' : 'not_identified',
    match
      ? [{ source: 'html', snippet: `assinatura ${match[0]} encontrada`, confidence: 'high' }]
      : [],
    [page.finalUrl],
    'Gerenciamento e entrega de conteúdo.',
    ['Um CMS headless pode não expor assinaturas no cliente.'],
  );
}

function publicApiFinding(page: CrawledPage): InvestigationFinding {
  const calls = page.networkLog.filter(
    (entry) => entry.resourceType === 'xhr' || entry.resourceType === 'fetch',
  );
  const endpoints = unique(
    calls.map((entry) => `${entry.method} ${sanitizeUrl(entry.url)} ${entry.status ?? ''}`),
  );
  return finding(
    'Endpoints públicos observados',
    'APIs e comunicação',
    safeJson({
      endpoints,
      styles: {
        graphql: endpoints.filter((item) => /graphql|gql/i.test(item)).length,
        restLike: endpoints.filter((item) => !/graphql|gql/i.test(item)).length,
      },
    }),
    endpoints.length ? 'confirmed' : 'not_identified',
    endpoints
      .slice(0, 20)
      .map((endpoint) => ({ source: 'network', snippet: endpoint, confidence: 'high' })),
    [page.finalUrl],
    'Comunicação pública observada durante o carregamento.',
    [
      'Somente chamadas disparadas nesta navegação foram capturadas; parâmetros sensíveis foram removidos.',
    ],
  );
}

function section(title: string, findings: InvestigationFinding[]) {
  const identified = findings.filter((item) => item.confidence !== 'not_identified').length;
  return {
    title,
    summary: `${identified} de ${findings.length} dimensões possuem evidência observável nesta execução.`,
    findings,
  };
}

function finding(
  name: string,
  category: string,
  result: string,
  confidence: InvestigationConfidence,
  evidence: Evidence[],
  locations: string[],
  probableFunction: string,
  limitations: string[],
): InvestigationFinding {
  return { name, category, result, confidence, evidence, locations, probableFunction, limitations };
}

function select(findings: InvestigationFinding[], dimensions: string[]): InvestigationFinding[] {
  return dimensions
    .map((dimension) => findings.find((item) => item.category === dimension))
    .filter((item): item is InvestigationFinding => Boolean(item));
}

function confidenceFromEvidence(evidence: Evidence[], positive: boolean): InvestigationConfidence {
  if (!positive) return 'not_identified';
  if (evidence.some((item) => item.confidence === 'high')) return 'confirmed';
  if (evidence.filter((item) => item.confidence === 'medium').length >= 2)
    return 'highly_probable';
  return evidence.length ? 'probable' : 'not_identified';
}

function hasSignal(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'string')
    return value.length > 0 && !['unknown', 'none'].includes(value.toLowerCase());
  if (typeof value === 'number') return value > 0;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.values(value).some(hasSignal);
  return false;
}

function safeJson(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2) ?? 'Não identificado';
  return serialized.slice(0, 8_000);
}

function summarizeSystem(page: CrawledPage): string {
  const forms = (page.html.match(/<form\b/gi) ?? []).length;
  const title = page.meta.title ? `“${page.meta.title}”` : 'sem título público';
  return `Página web ${title}, resposta HTTP ${page.status}, com ${forms} formulário(s) e ${page.networkLog.length} recurso(s) de rede observados. O objetivo de negócio além do conteúdo público não é inferido sem evidência adicional.`;
}

function buildRisks(
  page: CrawledPage,
  accessibility: InvestigationFinding,
  security: InvestigationFinding,
) {
  const accessibilityData = JSON.parse(accessibility.result) as {
    imagesMissingAlt: number;
    htmlLanguage: string | null;
    skippedHeading: boolean;
  };
  const risks: Array<{
    severity: 'critical' | 'high' | 'medium' | 'low' | 'informational';
    status: 'confirmed_problem' | 'potential_risk' | 'not_identified' | 'limitation';
    title: string;
    description: string;
    evidence: Evidence[];
  }> = [];
  if (accessibilityData.imagesMissingAlt > 0)
    risks.push({
      severity: 'medium',
      status: 'confirmed_problem',
      title: 'Imagens sem atributo alt',
      description: `${accessibilityData.imagesMissingAlt} imagem(ns) não possuem atributo alt observável.`,
      evidence: accessibility.evidence,
    });
  if (!accessibilityData.htmlLanguage)
    risks.push({
      severity: 'medium',
      status: 'confirmed_problem',
      title: 'Idioma do documento ausente',
      description: 'O elemento HTML não declarou idioma na captura.',
      evidence: accessibility.evidence,
    });
  if (accessibilityData.skippedHeading)
    risks.push({
      severity: 'low',
      status: 'potential_risk',
      title: 'Hierarquia de headings',
      description: 'Há salto de nível na sequência de headings observada.',
      evidence: accessibility.evidence,
    });
  if (!page.headers['content-security-policy'])
    risks.push({
      severity: 'medium',
      status: 'potential_risk',
      title: 'CSP não observada',
      description:
        'A resposta analisada não incluiu Content-Security-Policy. Isso requer confirmação em outras rotas e no edge.',
      evidence: security.evidence,
    });
  if (!page.headers['strict-transport-security'] && page.finalUrl.startsWith('https:'))
    risks.push({
      severity: 'medium',
      status: 'potential_risk',
      title: 'HSTS não observado',
      description: 'A resposta HTTPS não apresentou Strict-Transport-Security.',
      evidence: security.evidence,
    });
  risks.push({
    severity: 'informational',
    status: 'limitation',
    title: 'Cobertura externa limitada',
    description:
      'Áreas privadas, fluxos após interação e infraestrutura interna não foram acessados.',
    evidence: [],
  });
  return risks;
}

function buildRecommendations(
  risks: ReturnType<typeof buildRisks>,
  byDimension: Map<string, DetectorResult>,
) {
  const recommendations = risks
    .filter((risk) => risk.status !== 'limitation')
    .map((risk) => ({
      priority:
        risk.severity === 'critical'
          ? ('critical' as const)
          : risk.severity === 'high'
            ? ('high' as const)
            : risk.severity === 'medium'
              ? ('medium' as const)
              : ('low' as const),
      title: `Tratar: ${risk.title}`,
      rationale: risk.description,
    }));
  if (byDimension.get('performance')?.status === 'ok')
    recommendations.push({
      priority: 'medium',
      title: 'Medir Core Web Vitals em campo',
      rationale: 'A captura sintética não substitui RUM para LCP, CLS e INP reais.',
    });
  recommendations.push({
    priority: 'low',
    title: 'Validar conclusões no repositório autorizado',
    rationale:
      'Código-fonte e configuração de deploy elevam hipóteses públicas a conclusões confirmadas.',
  });
  return recommendations;
}

function buildDiagram(byDimension: Map<string, DetectorResult>, page: CrawledPage): string {
  const lines = ['flowchart TD', '  U["Usuário"] --> FE["Frontend público"]'];
  if (
    page.networkLog.some((entry) => entry.resourceType === 'xhr' || entry.resourceType === 'fetch')
  )
    lines.push('  FE --> API["APIs públicas observadas"]');
  if (confidenceFor(byDimension.get('authProvider')) !== 'not_identified')
    lines.push('  FE --> AUTH["Autenticação identificada"]');
  if (confidenceFor(byDimension.get('analytics')) !== 'not_identified')
    lines.push('  FE --> ANALYTICS["Analytics identificado"]');
  if (confidenceFor(byDimension.get('cdn')) !== 'not_identified')
    lines.push('  U --> CDN["CDN identificada"]', '  CDN --> FE');
  if (confidenceFor(byDimension.get('backendFramework')) !== 'not_identified')
    lines.push('  API --> BE["Backend identificado"]');
  return lines.join('\n');
}

function estimatedStructure(byDimension: Map<string, DetectorResult>): string {
  const frameworkKnown = confidenceFor(byDimension.get('libraries')) !== 'not_identified';
  return frameworkKnown
    ? `src/\n├── app/\n│   ├── routes/\n│   ├── layouts/\n│   └── providers/\n├── components/\n│   ├── ui/\n│   ├── layout/\n│   └── domain/\n├── features/\n├── services/\n├── hooks/\n├── styles/\n├── assets/\n├── types/\n└── config/`
    : `public/\n├── assets/\n├── styles/\n└── scripts/\nsrc/\n├── components/\n├── services/\n└── config/`;
}

function buildConfidenceMatrix(
  byDimension: Map<string, DetectorResult>,
  cms: InvestigationFinding,
) {
  const rows: Array<[string, string]> = [
    ['Framework frontend', 'libraries'],
    ['Linguagem frontend', 'language'],
    ['Framework CSS', 'cssFramework'],
    ['Biblioteca de animação', 'animation'],
    ['Estratégia de renderização', 'architecture'],
    ['Tecnologia backend', 'backendFramework'],
    ['Padrão de API', 'apisConsumed'],
    ['Autenticação', 'authProvider'],
    ['Banco de dados', 'databaseIndicators'],
    ['CMS', 'cms'],
    ['Hospedagem', 'cloudProvider'],
    ['CDN', 'cdn'],
    ['Analytics', 'analytics'],
    ['Monitoramento', 'thirdPartyServices'],
  ];
  return rows.map(([information, dimension]) => {
    const result = byDimension.get(dimension);
    const confidence = dimension === 'cms' ? cms.confidence : confidenceFor(result);
    return {
      information,
      result:
        dimension === 'cms'
          ? cms.result
          : result?.status === 'ok' && hasSignal(result.data)
            ? safeJson(result.data).slice(0, 1_000)
            : 'Não identificado',
      confidence,
      justification:
        confidence === 'not_identified'
          ? 'Não há evidência pública suficiente nesta execução.'
          : `Classificação baseada nas evidências do detector ${dimension}.`,
    };
  });
}

function confidenceFor(result: DetectorResult | undefined): InvestigationConfidence {
  if (result?.status !== 'ok' || !hasSignal(result.data)) return 'not_identified';
  const technologies = detectedTechnologyNames(result);
  if (technologies.length === 0)
    return confidenceFromEvidence(result.evidence ?? [], true);

  const confidences = technologies.map((technology) =>
    confidenceFromEvidence(
      evidenceForTechnology(technology, result.evidence ?? [], technologies.length),
      true,
    ),
  );
  return (['confirmed', 'highly_probable', 'probable', 'not_identified'] as const).find(
    (confidence) => confidences.includes(confidence),
  ) ?? 'not_identified';
}

function collectTechnicalEvidence(
  page: CrawledPage,
  requestedUrl: string,
  byDimension: Map<string, DetectorResult>,
) {
  const sensitiveHeaders = new Set([
    'authorization',
    'cf-connecting-ip',
    'cookie',
    'fastly-client-ip',
    'forwarded',
    'proxy-authorization',
    'set-cookie',
    'true-client-ip',
    'x-client-ip',
    'x-forwarded-for',
    'x-real-ip',
  ]);
  const safeHeaders = Object.fromEntries(
    Object.entries(page.headers).filter(([name]) => !sensitiveHeaders.has(name.toLowerCase())),
  );
  const scripts = unique(
    page.scripts.map((script) => script.src).filter((value): value is string => Boolean(value)),
  ).slice(0, 300);
  const stylesheets = unique(
    page.stylesheets.map((style) => style.href).filter((value): value is string => Boolean(value)),
  ).slice(0, 300);
  const urls = [...scripts, ...stylesheets, ...page.networkLog.map((entry) => entry.url)];
  const externalDomains = unique(
    urls
      .map((url) => safeHost(url))
      .filter((value): value is string => Boolean(value) && value !== safeHost(page.finalUrl)),
  );
  const publicEndpoints = unique(
    page.networkLog
      .filter((entry) => entry.resourceType === 'xhr' || entry.resourceType === 'fetch')
      .map((entry) => `${entry.method} ${sanitizeUrl(entry.url)}`),
  );
  const tokenData = byDimension.get('designTokens');
  const cssVariables =
    tokenData?.status === 'ok' &&
    tokenData.data &&
    typeof tokenData.data === 'object' &&
    Array.isArray((tokenData.data as { customProperties?: unknown }).customProperties)
      ? (
          tokenData.data as { customProperties: Array<{ name?: string; value?: string }> }
        ).customProperties
          .map((property) => `${property.name ?? ''}: ${property.value ?? ''}`)
          .slice(0, 300)
      : [];
  const typography = byDimension.get('typography');
  const fonts =
    typography?.status === 'ok'
      ? extractStrings(typography.data)
          .filter((value) => /font|woff|serif|sans/i.test(value))
          .slice(0, 100)
      : [];
  const manifests = page.linkRel
    .filter((link) => link.rel.toLowerCase().includes('manifest'))
    .map((link) => link.href);
  const serviceWorkers = page.scripts
    .flatMap((script) =>
      [script.src, script.content].filter((value): value is string => Boolean(value)),
    )
    .filter((value) => /serviceWorker|service-worker|sw\.js/i.test(value))
    .map((value) => value.slice(0, 2_048));
  return {
    analyzedUrls: unique([requestedUrl, page.finalUrl]),
    relevantHeaders: safeHeaders,
    scripts,
    stylesheets,
    externalDomains,
    publicEndpoints,
    cookies: page.cookies.map(
      (cookie) =>
        `${cookie.name}; domain=${cookie.domain ?? ''}; secure=${Boolean(cookie.secure)}; httpOnly=${Boolean(cookie.httpOnly)}; sameSite=${cookie.sameSite ?? ''}`,
    ),
    cssVariables,
    fonts,
    metadata: Object.fromEntries(
      Object.entries(page.meta).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
    manifests,
    serviceWorkers,
  };
}

function extractStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(extractStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(extractStrings);
  return [];
}

function sanitizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.search = '';
    url.hash = '';
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return raw.split('?')[0] ?? raw;
  }
}

function safeHost(raw: string): string | null {
  try {
    return new URL(raw).host;
  } catch {
    return null;
  }
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}
