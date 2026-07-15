import type { CrawledPage } from '@extractionstack/shared';
import { BaseDetector, evHigh, evMed } from './detector.interface.js';

interface RoutingData {
  detected: string[];
  primary: string | null;
  strategy: 'file-based' | 'config-based' | 'history-api' | 'hash' | 'unknown';
}

const SIGNATURES: Array<{ name: string; patterns: RegExp[] }> = [
  { name: 'react-router', patterns: [/react-router|createBrowserRouter|<MemoryRouter/] },
  { name: 'next.js', patterns: [/next\/link|__NEXT_DATA__|next\/router/] },
  { name: 'vue-router', patterns: [/vue-router|createRouter\(|<router-link/] },
  { name: 'nuxt', patterns: [/__NUXT__|useRoute\(\)/, /nuxt-link/] },
  { name: 'sveltekit', patterns: [/__sveltekit\/|from '\$app\/navigation'/] },
  { name: 'tanstack-router', patterns: [/@tanstack\/react-router|createRouter\(\{.*routeTree/] },
  { name: 'wouter', patterns: [/\bwouter\b/] },
  { name: 'reach-router', patterns: [/@reach\/router/] },
  { name: 'gatsby', patterns: [/\bgatsby\b|@reach\/router/] },
];

export class RoutingDetector extends BaseDetector<RoutingData> {
  readonly dimension = 'routing' as const;

  async detect(page: CrawledPage): Promise<import('@extractionstack/shared').DetectorResult<RoutingData>> {
    const detected = new Set<string>();
    const evidence: import('@extractionstack/shared').Evidence[] = [];
    for (const sig of SIGNATURES) {
      for (const s of page.scripts) {
        const blob = (s.src ?? '') + ' ' + (s.content ?? '');
        if (sig.patterns.some((p) => p.test(blob))) {
          detected.add(sig.name);
          evidence.push(evHigh('script', `${sig.name} in ${(s.src ?? 'inline script').slice(0, 80)}`));
          break;
        }
      }
      if (!detected.has(sig.name) && sig.patterns.some((p) => p.test(page.html))) {
        detected.add(sig.name);
        evidence.push(evHigh('html', `${sig.name} marker in HTML`));
      }
    }

    let strategy: RoutingData['strategy'] = 'unknown';
    if (detected.has('next.js') || detected.has('nuxt') || detected.has('sveltekit') || detected.has('gatsby')) {
      strategy = 'file-based';
    } else if (detected.size > 0) {
      strategy = 'config-based';
    } else if (/history\.pushState|window\.history/.test(page.html)) {
      strategy = 'history-api';
      evidence.push(evMed('script', 'history.pushState found in scripts'));
    } else if (page.finalUrl.includes('#')) {
      strategy = 'hash';
    }

    return this.ok(
      { detected: Array.from(detected), primary: Array.from(detected)[0] ?? null, strategy },
      evidence,
    );
  }
}
