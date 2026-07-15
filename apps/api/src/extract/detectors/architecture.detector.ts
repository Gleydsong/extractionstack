import type { CrawledPage } from '@extractionstack/shared';
import { BaseDetector, evHigh, evMed } from './detector.interface.js';

interface ArchitectureData {
  rendering: 'ssr' | 'spa' | 'ssg' | 'isr' | 'mpa' | 'unknown';
  apiStyle: 'rest' | 'graphql' | 'mixed' | 'unknown';
  monolith: 'monolith' | 'distributed' | 'unknown';
  signals: string[];
  evidence: import('@extractionstack/shared').Evidence[];
}

const SSG_SIGNALS: RegExp[] = [/getStaticProps/, /prerendered/i, /__NUXT__\s*=\s*{[^}]*static/];
const ISR_SIGNALS: RegExp[] = [/revalidate:|revalidatePath\(/];
const SSR_SIGNALS: RegExp[] = [/getServerSideProps/, /__NUXT__/];
const SPA_SIGNALS: RegExp[] = [/data-reactroot/, /__REACT_DEVTOOLS/, /spa-/];

export class ArchitectureDetector extends BaseDetector<ArchitectureData> {
  readonly dimension = 'architecture' as const;

  async detect(page: CrawledPage): Promise<import('@extractionstack/shared').DetectorResult<ArchitectureData>> {
    const signals: string[] = [];
    const evidence: import('@extractionstack/shared').Evidence[] = [];

    let rendering: ArchitectureData['rendering'] = 'unknown';
    if (SSG_SIGNALS.some((p) => p.test(page.html))) {
      rendering = 'ssg';
      signals.push('SSG markers (getStaticProps)');
      evidence.push(evHigh('script', 'getStaticProps in HTML'));
    } else if (ISR_SIGNALS.some((p) => p.test(page.html))) {
      rendering = 'isr';
      signals.push('ISR markers (revalidate)');
      evidence.push(evHigh('script', 'revalidate in HTML'));
    } else if (SSR_SIGNALS.some((p) => p.test(page.html))) {
      rendering = 'ssr';
      signals.push('SSR markers (getServerSideProps)');
      evidence.push(evMed('script', 'SSR markers in HTML'));
    } else if (SPA_SIGNALS.some((p) => p.test(page.html))) {
      rendering = 'spa';
      signals.push('SPA markers (data-reactroot)');
      evidence.push(evMed('script', 'SPA markers in HTML'));
    }
    if (rendering === 'unknown' && (page.meta.htmlLang || page.meta.title)) {
      rendering = 'mpa';
      evidence.push(evMed('meta', 'document metadata present', 'MPA fallback inference'));
    }

    const graphqlCalls = page.networkLog.filter((n) => /\/graphql(\?|$|#)|\/gql(\?|$|#)/.test(n.url)).length;
    const restCalls = page.networkLog.filter(
      (n) => (n.resourceType === 'xhr' || n.resourceType === 'fetch') && !/\/graphql|\/gql/.test(n.url),
    ).length;
    let apiStyle: ArchitectureData['apiStyle'] = 'unknown';
    if (graphqlCalls > 0 && restCalls > 0) apiStyle = 'mixed';
    else if (graphqlCalls > 0) apiStyle = 'graphql';
    else if (restCalls > 0) apiStyle = 'rest';
    if (graphqlCalls > 0) evidence.push(evHigh('network', `${graphqlCalls} GraphQL call(s)`));
    if (restCalls > 0) evidence.push(evMed('network', `${restCalls} REST-like call(s)`));

    const distinctHosts = new Set(page.networkLog.map((n) => safeHost(n.url)).filter((h): h is string => !!h));
    let monolith: ArchitectureData['monolith'] = 'unknown';
    if (distinctHosts.size === 0) monolith = 'unknown';
    else if (distinctHosts.size <= 2) monolith = 'monolith';
    else if (distinctHosts.size <= 5) monolith = 'monolith';
    else {
      monolith = 'distributed';
      signals.push(`${distinctHosts.size} distinct hosts`);
    }

    return this.ok(
      { rendering, apiStyle, monolith, signals, evidence },
      evidence,
    );
  }
}

function safeHost(u: string): string | null {
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
}
