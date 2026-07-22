import type { Dimension } from '@extractionstack/shared';

/* =========================================================
   Human-language rendering of detector data
   ---------------------------------------------------------
   Each detector dimension has a tailored renderer. Unknown
   dimensions fall back to a generic key/value list that
   still avoids raw JSON.
   ========================================================= */

export type DataValue =
  string | number | boolean | null | undefined | DataValue[] | { [key: string]: DataValue };

export interface DataRow {
  key: string;
  value: string;
  /** Optional badge items rendered as chips below the value. */
  chips?: string[];
  /** Optional inline highlight rendered as a headline above the row. */
  headline?: string;
}

export interface HumanSummary {
  /** One-sentence summary in PT-BR. */
  headline: string;
  /** Ordered list of key/value rows. */
  rows: DataRow[];
  /** True if no useful information was found. */
  empty: boolean;
}

const NON_BREAKING_SPACE = '\u00a0';

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return {};
}

function joinList(items: string[], max = 8): string {
  if (items.length === 0) return '';
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} e mais ${items.length - max}`;
}

function readableFieldLabel(raw: string): string {
  // Convert camelCase / snake_case into PT-BR-friendly labels.
  const cleaned = raw
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
  return cleaned;
}

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string' && v.trim().length === 0) return true;
  if (Array.isArray(v) && v.length === 0) return true;
  if (typeof v === 'object' && Object.keys(v as object).length === 0) return true;
  return false;
}

function formatSimple(v: unknown): string {
  if (v === null || v === undefined) return 'Não identificado';
  if (typeof v === 'boolean') return v ? 'Sim' : 'Não';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'Não identificado';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return joinList(v.map((x) => String(x)));
  if (typeof v === 'object') {
    return joinList(
      Object.entries(v as Record<string, unknown>).map(
        ([k, x]) => `${readableFieldLabel(k)}: ${formatSimple(x)}`,
      ),
    );
  }
  return String(v);
}

function asStringArray(v: unknown): string[] {
  return asArray(v).map((x) => (typeof x === 'string' ? x : formatSimple(x)));
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function asBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  return null;
}

/* ---------------------------------------------------------
   Per-dimension renderers
   --------------------------------------------------------- */

function renderSeo(data: Record<string, unknown>): HumanSummary {
  const title = typeof data.title === 'string' ? data.title : null;
  const description = typeof data.description === 'string' ? data.description : null;
  const canonical = typeof data.canonical === 'string' ? data.canonical : null;
  const robots = typeof data.robots === 'string' ? data.robots : null;
  const openGraph = asRecord(data.openGraph);
  const twitter = asRecord(data.twitter);
  const hasSitemap = asBool(data.hasSitemap);
  const hasRobotsTxt = asBool(data.hasRobotsTxt);
  const jsonLd = asNumber(data.jsonLd) ?? 0;

  const ogCount = Object.keys(openGraph).length;
  const twCount = Object.keys(twitter).length;
  const empty =
    !title && !description && ogCount === 0 && twCount === 0 && !hasSitemap && !hasRobotsTxt;

  if (empty) {
    return {
      headline: 'Nenhuma informação pública de SEO foi identificada na página.',
      rows: [],
      empty: true,
    };
  }

  const ogPreview = asStringArray(Object.values(openGraph)).slice(0, 3);
  const twPreview = asStringArray(Object.values(twitter)).slice(0, 3);

  return {
    headline: title
      ? `Página identificada com o título “${title}”.`
      : 'A página não publicou um título público.',
    rows: [
      { key: 'Título', value: title ?? 'Não identificado' },
      { key: 'Descrição', value: description ?? 'Não identificada' },
      {
        key: 'Open Graph',
        value:
          ogCount === 0
            ? 'Não foram encontrados metadados Open Graph.'
            : `${ogCount} metadado${ogCount === 1 ? '' : 's'} encontrado${ogCount === 1 ? '' : 's'}.`,
        chips: ogPreview,
      },
      {
        key: 'Twitter Card',
        value:
          twCount === 0
            ? 'Não foram encontrados metadados de Twitter.'
            : `${twCount} metadado${twCount === 1 ? '' : 's'} encontrado${twCount === 1 ? '' : 's'}.`,
        chips: twPreview,
      },
      { key: 'URL canônica', value: canonical ?? 'Não definida' },
      { key: 'Diretiva robots', value: robots ?? 'Não definida' },
      {
        key: 'Sitemap',
        value:
          hasSitemap === null ? 'Não verificado' : hasSitemap ? 'Encontrado' : 'Não encontrado',
      },
      {
        key: 'Robots.txt',
        value:
          hasRobotsTxt === null ? 'Não verificado' : hasRobotsTxt ? 'Encontrado' : 'Não encontrado',
      },
      {
        key: 'Dados estruturados (JSON-LD)',
        value:
          jsonLd === 0
            ? 'Nenhum bloco JSON-LD identificado.'
            : `${jsonLd} bloco${jsonLd === 1 ? '' : 's'} JSON-LD identificado${jsonLd === 1 ? '' : 's'}.`,
      },
    ],
    empty: false,
  };
}

function renderDetectedList(
  data: Record<string, unknown>,
  fallbackNoun: string,
  extraRows: DataRow[] = [],
): HumanSummary {
  const detected = asStringArray(data.detected);
  const primary = typeof data.primary === 'string' ? data.primary : null;

  if (detected.length === 0) {
    return {
      headline: `Nenhum ${fallbackNoun} pôde ser identificado com as evidências disponíveis.`,
      rows: extraRows,
      empty: true,
    };
  }

  return {
    headline: primary
      ? `${fallbackNoun.charAt(0).toUpperCase() + fallbackNoun.slice(1)} principal identificado: ${primary}.`
      : `Foram identificados ${detected.length} ${fallbackNoun}${detected.length === 1 ? '' : 's'}.`,
    rows: [
      {
        key: 'Detectados',
        value:
          detected.length === 1 ? detected[0]! : `Lista de ${detected.length} itens encontrados.`,
        chips: detected,
      },
      ...extraRows,
    ],
    empty: false,
  };
}

function renderCssFramework(data: Record<string, unknown>): HumanSummary {
  return renderDetectedList(data, 'framework CSS');
}

function renderBackendFramework(data: Record<string, unknown>): HumanSummary {
  const languages = asStringArray(data.language);
  const server = typeof data.server === 'string' ? data.server : null;
  const poweredBy = typeof data.poweredBy === 'string' ? data.poweredBy : null;
  return renderDetectedList(data, 'framework de servidor', [
    {
      key: 'Linguagem inferida',
      value: languages.length ? joinList(languages) : 'Não identificada',
    },
    { key: 'Servidor HTTP', value: server ?? 'Não identificado' },
    { key: 'Cabeçalho X-Powered-By', value: poweredBy ?? 'Não exposto' },
  ]);
}

function renderCdn(data: Record<string, unknown>): HumanSummary {
  return renderDetectedList(data, 'CDN');
}

function renderCloudProvider(data: Record<string, unknown>): HumanSummary {
  return renderDetectedList(data, 'provedor de nuvem');
}

function renderReverseProxy(data: Record<string, unknown>): HumanSummary {
  return renderDetectedList(data, 'proxy reverso');
}

function renderAuthProvider(data: Record<string, unknown>): HumanSummary {
  return renderDetectedList(data, 'provedor de autenticação');
}

function renderAnalytics(data: Record<string, unknown>): HumanSummary {
  return renderDetectedList(data, 'serviço de analytics');
}

function renderThirdPartyServices(data: Record<string, unknown>): HumanSummary {
  return renderDetectedList(data, 'serviço de terceiro');
}

function renderLibraries(data: Record<string, unknown>): HumanSummary {
  const detected = asStringArray(data.detected);
  const byCategory = asRecord(data.byCategory);
  const groups = Object.entries(byCategory).map(([category, items]) => {
    const list = asStringArray(items);
    return `${category}: ${list.length ? joinList(list) : 'nenhum'}`;
  });
  if (detected.length === 0) {
    return {
      headline: 'Nenhuma biblioteca de frontend foi identificada.',
      rows: [],
      empty: true,
    };
  }
  return {
    headline: `Foram identificadas ${detected.length} biblioteca${detected.length === 1 ? '' : 's'} de frontend.`,
    rows: [
      { key: 'Detectadas', value: joinList(detected, 12), chips: detected },
      ...(groups.length ? [{ key: 'Por categoria', value: joinList(groups) }] : []),
    ],
    empty: false,
  };
}

function renderStateManagement(data: Record<string, unknown>): HumanSummary {
  const detected = asStringArray(data.detected);
  if (detected.length === 0) {
    return {
      headline: 'Nenhuma biblioteca de gerenciamento de estado foi identificada.',
      rows: [],
      empty: true,
    };
  }
  return {
    headline: 'Gerenciamento de estado identificado.',
    rows: [{ key: 'Detectado', value: joinList(detected), chips: detected }],
    empty: false,
  };
}

function renderRouting(data: Record<string, unknown>): HumanSummary {
  return renderDetectedList(data, 'mecanismo de roteamento');
}

function renderComponentArchitecture(data: Record<string, unknown>): HumanSummary {
  const framework = typeof data.framework === 'string' ? data.framework : null;
  const versionHints = asStringArray(data.versionHints);
  const hydration = typeof data.hydration === 'string' ? data.hydration : null;
  const markers = asStringArray(data.markers);

  if (!framework) {
    return {
      headline: 'Não foi possível identificar a arquitetura de componentes.',
      rows: [],
      empty: true,
    };
  }

  return {
    headline: `Arquitetura de componentes baseada em ${framework}.`,
    rows: [
      { key: 'Framework', value: framework },
      {
        key: 'Sinais de versão',
        value: versionHints.length ? joinList(versionHints) : 'Nenhum indício explícito',
      },
      { key: 'Hidratação', value: hydration ?? 'Não avaliada' },
      { key: 'Marcadores observados', value: markers.length ? joinList(markers) : 'Nenhum' },
    ],
    empty: false,
  };
}

function renderDesignSystem(data: Record<string, unknown>): HumanSummary {
  return renderDetectedList(data, 'design system');
}

function renderTypography(data: Record<string, unknown>): HumanSummary {
  const fonts = asStringArray(data.fonts ?? data.families ?? data.detected);
  const hasGoogle = asBool(data.hasGoogleFonts ?? data.googleFonts);
  return renderDetectedList({ detected: fonts }, 'família tipográfica', [
    {
      key: 'Google Fonts',
      value: hasGoogle === null ? 'Não avaliado' : hasGoogle ? 'Sim' : 'Não',
    },
  ]);
}

function renderPalette(data: Record<string, unknown>): HumanSummary {
  const background = asStringArray(data.backgroundColors);
  const text = asStringArray(data.textColors);
  const border = asStringArray(data.borderColors);
  const sample = asStringArray(data.sample);
  if (background.length === 0 && text.length === 0 && border.length === 0) {
    return {
      headline: 'Nenhuma paleta de cores pôde ser amostrada.',
      rows: [],
      empty: true,
    };
  }
  return {
    headline: `Paleta aproximada extraída do CSS computado.`,
    rows: [
      {
        key: 'Cores de fundo',
        value: background.length
          ? `${background.length} cor${background.length === 1 ? '' : 'es'}`
          : 'Nenhuma',
        chips: background,
      },
      {
        key: 'Cores de texto',
        value: text.length ? `${text.length} cor${text.length === 1 ? '' : 'es'}` : 'Nenhuma',
        chips: text,
      },
      {
        key: 'Cores de borda',
        value: border.length ? `${border.length} cor${border.length === 1 ? '' : 'es'}` : 'Nenhuma',
        chips: border,
      },
    ],
    empty: false,
  };
}

function renderDesignTokens(data: Record<string, unknown>): HumanSummary {
  const tokens = asStringArray(data.tokens ?? data.variables ?? data.detected);
  if (tokens.length === 0) {
    return {
      headline: 'Nenhum token de design identificado.',
      rows: [],
      empty: true,
    };
  }
  return {
    headline: 'Design tokens identificados.',
    rows: [{ key: 'Tokens', value: joinList(tokens, 10), chips: tokens.slice(0, 12) }],
    empty: false,
  };
}

function renderIcons(data: Record<string, unknown>): HumanSummary {
  const libraries = asStringArray(data.libraries);
  const totalIcons = asNumber(data.totalIcons) ?? 0;
  const inlineSvg = asNumber(data.inlineSvgCount) ?? 0;
  if (libraries.length === 0 && totalIcons === 0) {
    return {
      headline: 'Nenhum ícone identificado na página.',
      rows: [],
      empty: true,
    };
  }
  return {
    headline: `Sistema de ícones observado${libraries.length ? ` (${libraries.join(', ')})` : ''}.`,
    rows: [
      {
        key: 'Bibliotecas',
        value: libraries.length ? joinList(libraries) : 'Nenhuma',
        chips: libraries,
      },
      { key: 'SVGs inline', value: inlineSvg > 0 ? String(inlineSvg) : 'Nenhum' },
      { key: 'Total estimado', value: totalIcons > 0 ? String(totalIcons) : 'Não estimado' },
    ],
    empty: false,
  };
}

function renderResponsive(data: Record<string, unknown>): HumanSummary {
  const viewport = typeof data.viewport === 'string' ? data.viewport : null;
  const mediaQueries = asStringArray(data.mediaQueries);
  const containerQueries = asStringArray(data.containerQueries);
  const empty = !viewport && mediaQueries.length === 0;
  if (empty) {
    return {
      headline: 'Nenhuma evidência de comportamento responsivo identificada.',
      rows: [],
      empty: true,
    };
  }
  return {
    headline: viewport
      ? `Viewport declarado: ${viewport}.`
      : 'A página parece se adaptar a diferentes tamanhos.',
    rows: [
      { key: 'Viewport', value: viewport ?? 'Não declarado' },
      {
        key: 'Media queries',
        value:
          mediaQueries.length === 0
            ? 'Nenhuma coletada'
            : `${mediaQueries.length} regra${mediaQueries.length === 1 ? '' : 's'} identificada${mediaQueries.length === 1 ? '' : 's'}.`,
        chips: mediaQueries,
      },
      {
        key: 'Container queries',
        value:
          containerQueries.length === 0
            ? 'Nenhuma coletada'
            : `${containerQueries.length} regra${containerQueries.length === 1 ? '' : 's'} identificada${containerQueries.length === 1 ? '' : 's'}.`,
      },
    ],
    empty: false,
  };
}

function renderGridSystem(data: Record<string, unknown>): HumanSummary {
  const flex = asNumber(data.displayFlexCount) ?? 0;
  const grid = asNumber(data.displayGridCount) ?? 0;
  const inlineFlex = asNumber(data.inlineStyleFlex) ?? 0;
  const inlineGrid = asNumber(data.inlineStyleGrid) ?? 0;
  if (flex + grid + inlineFlex + inlineGrid === 0) {
    return {
      headline: 'Nenhum uso de Flexbox ou CSS Grid identificado.',
      rows: [],
      empty: true,
    };
  }
  const dominant = grid >= flex ? 'CSS Grid' : 'Flexbox';
  return {
    headline: `Sistema predominante: ${dominant}.`,
    rows: [
      { key: 'CSS Grid (folhas)', value: String(grid) },
      { key: 'Flexbox (folhas)', value: String(flex) },
      { key: 'Grid inline', value: String(inlineGrid) },
      { key: 'Flex inline', value: String(inlineFlex) },
    ],
    empty: false,
  };
}

function renderAnimation(data: Record<string, unknown>): HumanSummary {
  const keyframes = asStringArray(data.keyframes);
  const cssTransitions = asStringArray(data.cssTransitions);
  const cssAnimations = asStringArray(data.cssAnimations);
  const libs = asStringArray(data.libs);
  if (keyframes.length + cssTransitions.length + cssAnimations.length + libs.length === 0) {
    return {
      headline: 'Nenhuma animação CSS ou biblioteca identificada.',
      rows: [],
      empty: true,
    };
  }
  return {
    headline: 'Animações detectadas na página.',
    rows: [
      { key: 'Keyframes', value: String(keyframes.length), chips: keyframes },
      { key: 'Transições CSS', value: String(cssTransitions.length), chips: cssTransitions },
      { key: 'Animações CSS', value: String(cssAnimations.length), chips: cssAnimations },
      { key: 'Bibliotecas', value: libs.length ? joinList(libs) : 'Nenhuma', chips: libs },
    ],
    empty: false,
  };
}

function renderScrollAnimation(data: Record<string, unknown>): HumanSummary {
  const libs = asStringArray(data.libraries ?? data.detected);
  if (libs.length === 0) {
    return {
      headline: 'Nenhuma biblioteca de animação por scroll identificada.',
      rows: [],
      empty: true,
    };
  }
  return {
    headline: 'Animações por scroll detectadas.',
    rows: [{ key: 'Detectadas', value: joinList(libs), chips: libs }],
    empty: false,
  };
}

function renderTransition(data: Record<string, unknown>): HumanSummary {
  const sample = asStringArray(data.sample ?? data.transitions ?? data.detected);
  if (sample.length === 0) {
    return {
      headline: 'Nenhuma transição CSS identificada.',
      rows: [],
      empty: true,
    };
  }
  return {
    headline: `${sample.length} transição${sample.length === 1 ? '' : 'ões'} CSS identificada${sample.length === 1 ? '' : 's'}.`,
    rows: [{ key: 'Amostra', value: joinList(sample, 6), chips: sample.slice(0, 8) }],
    empty: false,
  };
}

function renderPerformance(data: Record<string, unknown>): HumanSummary {
  const fcp = data.firstContentfulPaint ?? data.fcp;
  const fp = data.firstPaint ?? data.fp;
  const dcl = data.domContentLoaded ?? data.dcl;
  const load = data.load;
  const total = data.total ?? data.totalBytes;
  const requests = asNumber(data.requests ?? data.requestCount);
  const empty = fcp == null && fp == null && dcl == null && load == null;
  if (empty) {
    return {
      headline: 'Nenhuma métrica de performance pôde ser coletada.',
      rows: [],
      empty: true,
    };
  }
  return {
    headline: 'Métricas de performance observáveis.',
    rows: [
      {
        key: 'First Contentful Paint',
        value: fcp == null ? 'Não medido' : `${fcp}${NON_BREAKING_SPACE}ms`,
      },
      { key: 'First Paint', value: fp == null ? 'Não medido' : `${fp}${NON_BREAKING_SPACE}ms` },
      {
        key: 'DOMContentLoaded',
        value: dcl == null ? 'Não medido' : `${dcl}${NON_BREAKING_SPACE}ms`,
      },
      { key: 'Load', value: load == null ? 'Não medido' : `${load}${NON_BREAKING_SPACE}ms` },
      { key: 'Requisições', value: requests == null ? 'Não contado' : String(requests) },
      { key: 'Total transferido', value: total == null ? 'Não estimado' : String(total) },
    ],
    empty: false,
  };
}

function renderApisConsumed(data: Record<string, unknown>): HumanSummary {
  const endpoints = asStringArray(data.endpoints ?? data.detected);
  if (endpoints.length === 0) {
    return {
      headline: 'Nenhum endpoint público identificado.',
      rows: [],
      empty: true,
    };
  }
  return {
    headline: `${endpoints.length} endpoint${endpoints.length === 1 ? '' : 's'} público${endpoints.length === 1 ? '' : 's'} observado${endpoints.length === 1 ? '' : 's'}.`,
    rows: [{ key: 'Endpoints', value: joinList(endpoints, 8), chips: endpoints }],
    empty: false,
  };
}

function renderDatabaseIndicators(data: Record<string, unknown>): HumanSummary {
  const detected = asStringArray(data.detected);
  return renderDetectedList({ detected }, 'indicador de banco de dados');
}

function renderDockerKubernetes(data: Record<string, unknown>): HumanSummary {
  const docker = asStringArray(data.docker);
  const k8s = asStringArray(data.kubernetes);
  if (docker.length === 0 && k8s.length === 0) {
    return {
      headline: 'Nenhum sinal de containerização ou orquestração identificado.',
      rows: [],
      empty: true,
    };
  }
  return {
    headline: 'Sinais de containerização identificados.',
    rows: [
      {
        key: 'Docker',
        value: docker.length ? joinList(docker) : 'Não identificado',
        chips: docker,
      },
      { key: 'Kubernetes', value: k8s.length ? joinList(k8s) : 'Não identificado', chips: k8s },
    ],
    empty: false,
  };
}

function renderArchitecture(data: Record<string, unknown>): HumanSummary {
  const mode = typeof data.mode === 'string' ? data.mode : null;
  const signals = asStringArray(data.signals ?? data.indicators);
  if (!mode) {
    return {
      headline: 'Padrão de renderização não identificado.',
      rows: [],
      empty: true,
    };
  }
  return {
    headline: `Padrão de renderização observado: ${mode}.`,
    rows: [
      { key: 'Modo', value: mode },
      { key: 'Sinais', value: signals.length ? joinList(signals) : 'Nenhum' },
    ],
    empty: false,
  };
}

function renderCssCustomization(data: Record<string, unknown>): HumanSummary {
  const approach = typeof data.approach === 'string' ? data.approach : null;
  const custom = asStringArray(data.customProperties ?? data.variables);
  if (!approach) {
    return {
      headline: 'Estratégia de estilização não identificada.',
      rows: [],
      empty: true,
    };
  }
  return {
    headline: `Estratégia de estilização: ${approach}.`,
    rows: [
      { key: 'Abordagem', value: approach },
      {
        key: 'Variáveis CSS',
        value: custom.length ? joinList(custom, 8) : 'Nenhuma observada',
        chips: custom.slice(0, 10),
      },
    ],
    empty: false,
  };
}

function renderLanguage(data: Record<string, unknown>): HumanSummary {
  const detected = asStringArray(data.detected ?? data.languages);
  if (detected.length === 0) {
    return {
      headline: 'Nenhuma linguagem de programação pôde ser inferida.',
      rows: [],
      empty: true,
    };
  }
  return {
    headline: `Linguagens inferidas: ${joinList(detected)}.`,
    rows: [{ key: 'Linguagens', value: joinList(detected), chips: detected }],
    empty: false,
  };
}

function renderResponsiveGridMerged(data: Record<string, unknown>): HumanSummary {
  const responsive = asRecord(data.responsive);
  const grid = asRecord(data.grid);
  const r = renderResponsive(responsive);
  const g = renderGridSystem(grid);
  return {
    headline:
      r.empty && g.empty
        ? 'Nenhuma evidência de responsividade ou grid identificada.'
        : `${g.empty ? '' : g.headline + ' '}${r.empty ? '' : r.headline}`.trim(),
    rows: [...(g.empty ? [] : g.rows), ...(r.empty ? [] : r.rows)],
    empty: r.empty && g.empty,
  };
}

/* ---------------------------------------------------------
   Generic fallback
   --------------------------------------------------------- */

function genericSummary(dimension: Dimension, data: unknown): HumanSummary {
  if (data === null || data === undefined) {
    return {
      headline: 'Sem dados estruturados para esta dimensão.',
      rows: [],
      empty: true,
    };
  }
  if (typeof data !== 'object') {
    return {
      headline: 'Informação observada.',
      rows: [{ key: readableFieldLabel(dimension), value: formatSimple(data) }],
      empty: false,
    };
  }
  const obj = data as Record<string, unknown>;
  const entries = Object.entries(obj);
  if (entries.length === 0) {
    return {
      headline: 'Nenhuma informação estruturada identificada.',
      rows: [],
      empty: true,
    };
  }
  const rows: DataRow[] = [];
  for (const [key, value] of entries) {
    if (isEmptyValue(value)) continue;
    if (Array.isArray(value)) {
      const list = asStringArray(value);
      if (list.length === 0) continue;
      rows.push({
        key: readableFieldLabel(key),
        value:
          list.length === 1 ? list[0]! : `${list.length} ${readableFieldLabel(key).toLowerCase()}`,
        chips: list.slice(0, 12),
      });
    } else {
      rows.push({ key: readableFieldLabel(key), value: formatSimple(value) });
    }
  }
  if (rows.length === 0) {
    return {
      headline: 'Nenhuma informação útil identificada.',
      rows: [],
      empty: true,
    };
  }
  return {
    headline: 'Resumo das evidências coletadas.',
    rows,
    empty: false,
  };
}

/* ---------------------------------------------------------
   Dispatcher
   --------------------------------------------------------- */

const RENDERERS: Partial<Record<Dimension, (data: Record<string, unknown>) => HumanSummary>> = {
  seo: renderSeo,
  cssFramework: renderCssFramework,
  cssCustomization: renderCssCustomization,
  designSystem: renderDesignSystem,
  typography: renderTypography,
  responsive: renderResponsive,
  gridSystem: renderGridSystem,
  animation: renderAnimation,
  scrollAnimation: renderScrollAnimation,
  transition: renderTransition,
  performance: renderPerformance,
  componentArchitecture: renderComponentArchitecture,
  designTokens: renderDesignTokens,
  palette: renderPalette,
  icons: renderIcons,
  backendFramework: renderBackendFramework,
  language: renderLanguage,
  libraries: renderLibraries,
  stateManagement: renderStateManagement,
  routing: renderRouting,
  authProvider: renderAuthProvider,
  apisConsumed: renderApisConsumed,
  thirdPartyServices: renderThirdPartyServices,
  analytics: renderAnalytics,
  cdn: renderCdn,
  cloudProvider: renderCloudProvider,
  reverseProxy: renderReverseProxy,
  databaseIndicators: renderDatabaseIndicators,
  dockerKubernetes: renderDockerKubernetes,
  architecture: renderArchitecture,
};

export function humanizeDetectorData(dimension: Dimension, raw: unknown): HumanSummary {
  const obj =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  // Special case: the merged responsive+grid dimension produced by ExtractService.
  if (dimension === 'responsive' && obj.responsive && obj.grid) {
    return renderResponsiveGridMerged(obj);
  }

  const renderer = RENDERERS[dimension];
  if (renderer) {
    return renderer(obj);
  }
  return genericSummary(dimension, raw);
}
