import { CrawledPage } from '@extractionstack/shared';
import { BaseDetector } from './detector.interface.js';

interface ComponentArchitectureData {
  framework: string | null;
  versionHints: string[];
  hydration: 'ssr' | 'spa' | 'static' | 'unknown';
  markers: string[];
}

const MARKERS: Array<{ framework: string; patterns: RegExp[]; versionPatterns: RegExp[] }> = [
  {
    framework: 'next.js',
    patterns: [/__NEXT_DATA__/, /_next\/static/, /data-next-/],
    versionPatterns: [/_next\/static\/chunks\/[\w/.-]+-v?(\d+\.\d+\.\d+)/],
  },
  {
    framework: 'nuxt',
    patterns: [/__NUXT__/, /__nuxt/, /_nuxt\//],
    versionPatterns: [/_nuxt\/[\w/.-]+-v?(\d+\.\d+\.\d+)/],
  },
  {
    framework: 'remix',
    patterns: [/__remixContext/, /remix_/],
    versionPatterns: [],
  },
  {
    framework: 'gatsby',
    patterns: [/___gatsby/, /gatsby-/],
    versionPatterns: [],
  },
  {
    framework: 'sveltekit',
    patterns: [/__sveltekit/, /sveltekit/],
    versionPatterns: [],
  },
  {
    framework: 'astro',
    patterns: [/astro-island/, /data-astro-/],
    versionPatterns: [],
  },
  {
    framework: 'react',
    patterns: [/data-reactroot/, /__REACT_DEVTOOLS_GLOBAL_HOOK__/],
    versionPatterns: [/react@(\d+\.\d+\.\d+)/],
  },
  {
    framework: 'vue',
    patterns: [/data-v-[a-f0-9]+/, /__VUE__/],
    versionPatterns: [],
  },
  {
    framework: 'angular',
    patterns: [/ng-version/, /<app-root/],
    versionPatterns: [/ng-version="(\d+\.\d+\.\d+)"/],
  },
];

export class ComponentArchitectureDetector extends BaseDetector<ComponentArchitectureData> {
  readonly dimension = 'componentArchitecture' as const;

  async detect(page: CrawledPage): Promise<import('@extractionstack/shared').DetectorResult<ComponentArchitectureData>> {
    const html = page.html;
    const markers: string[] = [];
    const versionHints: string[] = [];
    let framework: string | null = null;

    for (const m of MARKERS) {
      const hit = m.patterns.some((p) => p.test(html));
      if (hit) {
        markers.push(m.framework);
        if (!framework) framework = m.framework;
        for (const vp of m.versionPatterns) {
          const match = html.match(vp);
          if (match?.[1]) versionHints.push(`${m.framework}@${match[1]}`);
        }
      }
    }

    const hydration: ComponentArchitectureData['hydration'] = framework
      ? markers.includes('astro') ||
        markers.includes('gatsby') ||
        markers.includes('next.js') ||
        markers.includes('nuxt') ||
        markers.includes('sveltekit') ||
        markers.includes('remix')
        ? 'ssr'
        : 'spa'
      : 'unknown';

    return this.ok({ framework, versionHints, hydration, markers });
  }
}
