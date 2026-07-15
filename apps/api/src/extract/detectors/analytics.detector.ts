import type { CrawledPage } from '@extractionstack/shared';
import { BaseDetector, evHigh, evMed } from './detector.interface.js';

interface AnalyticsData {
  detected: { name: string; confidence: 'high' | 'medium' }[];
}

const SIGNATURES: Array<{ name: string; patterns: RegExp[]; domains?: RegExp[] }> = [
  { name: 'google-analytics', patterns: [/googletagmanager\.com\/gtag\/js|google-analytics\.com|gtag\(/, /UA-\d{4,}-\d{1,}|G-[A-Z0-9]{6,}/], domains: [/google-analytics\.com/, /googletagmanager\.com/] },
  { name: 'google-tag-manager', patterns: [/GTM-[A-Z0-9]{4,}|googletagmanager\.com\/gtm\.js/], domains: [/googletagmanager\.com/] },
  { name: 'google-analytics-4', patterns: [/G-[A-Z0-9]{6,}/] },
  { name: 'plausible', patterns: [/plausible\.io\/js|plausible\.io\/api/], domains: [/plausible\.io/] },
  { name: 'fathom', patterns: [/cdn\.usefathom\.com/], domains: [/cdn\.usefathom\.com/] },
  { name: 'mixpanel', patterns: [/mixpanel\.com|cdn\.mxpnl\.com|mixpanel\.init/], domains: [/cdn\.mxpnl\.com/] },
  { name: 'amplitude', patterns: [/amplitude\.com|cdn\.amplitude\.com|amplitude\.init/], domains: [/cdn\.amplitude\.com/] },
  { name: 'posthog', patterns: [/posthog\.com|us\.i\.posthog\.com|posthog\.init/], domains: [/\.i\.posthog\.com/] },
  { name: 'matomo', patterns: [/matomo\.cloud|matomo\.php/], domains: [/\.matomo\.cloud/] },
  { name: 'clarity', patterns: [/clarity\.ms|cdn\.clarity\.ms/], domains: [/www\.clarity\.ms/, /cdn\.clarity\.ms/] },
  { name: 'simpleanalytics', patterns: [/simpleanalytics\.com\/simple\.js/], domains: [/simpleanalytics\.com/] },
  { name: 'umami', patterns: [/umami\.is|umami\.track/], domains: [/umami\.is/] },
];

export class AnalyticsDetector extends BaseDetector<AnalyticsData> {
  readonly dimension = 'analytics' as const;

  async detect(page: CrawledPage): Promise<import('@extractionstack/shared').DetectorResult<AnalyticsData>> {
    const found = new Map<string, { name: string; confidence: 'high' | 'medium' }>();
    const evidence: import('@extractionstack/shared').Evidence[] = [];

    for (const sig of SIGNATURES) {
      let matched = false;
      for (const s of page.scripts) {
        const blob = (s.src ?? '') + ' ' + (s.content ?? '');
        if (sig.patterns.some((p) => p.test(blob))) {
          found.set(sig.name, { name: sig.name, confidence: 'high' });
          evidence.push(evHigh('script', `${sig.name} in ${(s.src ?? 'inline').slice(0, 80)}`));
          matched = true;
          break;
        }
      }
      if (matched) continue;
      for (const n of page.networkLog) {
        if (sig.domains?.some((d) => d.test(n.url))) {
          found.set(sig.name, { name: sig.name, confidence: 'high' });
          evidence.push(evHigh('network', `request to ${n.url.slice(0, 80)}`));
          matched = true;
          break;
        }
      }
      if (matched) continue;
      if (sig.patterns.some((p) => p.test(page.html))) {
        found.set(sig.name, { name: sig.name, confidence: 'medium' });
        evidence.push(evMed('html', `${sig.name} marker in HTML`));
      }
    }

    return this.ok({ detected: Array.from(found.values()) }, evidence);
  }
}
