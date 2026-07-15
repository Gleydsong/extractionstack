import type { CrawledPage } from '@extractionstack/shared';
import { BaseDetector, evHigh, evMed, evLow } from './detector.interface.js';

interface LibrariesData {
  detected: { name: string; confidence: 'high' | 'medium' | 'low' }[];
  byCategory: Record<string, string[]>;
}

const SIGNATURES: Array<{
  name: string;
  category: string;
  patterns: RegExp[];
  confidence: 'high' | 'medium' | 'low';
}> = [
  { name: 'react', category: 'ui', patterns: [/data-reactroot|__REACT_DEVTOOLS_GLOBAL_HOOK__/], confidence: 'high' },
  { name: 'vue', category: 'ui', patterns: [/__VUE__|Vue\./], confidence: 'high' },
  { name: 'svelte', category: 'ui', patterns: [/svelte-|\bsvelte:/], confidence: 'high' },
  { name: 'moment', category: 'date', patterns: [/\bmoment\b/], confidence: 'medium' },
  { name: 'dayjs', category: 'date', patterns: [/\bdayjs\b/], confidence: 'medium' },
  { name: 'luxon', category: 'date', patterns: [/\bluxon\b/], confidence: 'medium' },
  { name: 'date-fns', category: 'date', patterns: [/\bdate-fns\b/], confidence: 'medium' },
  { name: 'chart.js', category: 'charts', patterns: [/chart\.js|Chart\(/, /chart\.umd\.js/], confidence: 'high' },
  { name: 'd3', category: 'charts', patterns: [/\bd3\b/, /d3\.js/], confidence: 'medium' },
  { name: 'recharts', category: 'charts', patterns: [/\brecharts\b/], confidence: 'medium' },
  { name: 'highcharts', category: 'charts', patterns: [/Highcharts/], confidence: 'high' },
  { name: 'lodash', category: 'util', patterns: [/\b_\.debounce|\b_\.throttle|require\(['"]lodash/], confidence: 'medium' },
  { name: 'axios', category: 'http', patterns: [/\baxios\./], confidence: 'medium' },
  { name: 'swr', category: 'http', patterns: [/\buseSWR\b/], confidence: 'medium' },
  { name: 'tanstack-query', category: 'http', patterns: [/@tanstack\/react-query|useQuery\(/], confidence: 'medium' },
  { name: 'rxjs', category: 'util', patterns: [/\brxjs\b|BehaviorSubject|ReplaySubject/], confidence: 'medium' },
  { name: 'immutable', category: 'util', patterns: [/immutable\.js|require\(['"]immutable/], confidence: 'medium' },
  { name: 'zod', category: 'validation', patterns: [/\bzod\b/], confidence: 'medium' },
  { name: 'yup', category: 'validation', patterns: [/\byup\b/], confidence: 'medium' },
  { name: 'joi', category: 'validation', patterns: [/\bjoi\b/], confidence: 'medium' },
  { name: 'formik', category: 'forms', patterns: [/\bFormik\b|useFormik/], confidence: 'medium' },
  { name: 'react-hook-form', category: 'forms', patterns: [/react-hook-form|useForm\(/], confidence: 'high' },
];

export class LibrariesDetector extends BaseDetector<LibrariesData> {
  readonly dimension = 'libraries' as const;

  async detect(page: CrawledPage): Promise<import('@extractionstack/shared').DetectorResult<LibrariesData>> {
    const found: { name: string; confidence: 'high' | 'medium' | 'low' }[] = [];
    const byCategory: Record<string, string[]> = {};
    const evidence: import('@extractionstack/shared').Evidence[] = [];

    for (const sig of SIGNATURES) {
      const matches: string[] = [];
      for (const s of page.scripts) {
        const src = s.src;
        const content = s.content;
        if (src && sig.patterns.some((p) => p.test(src))) matches.push(src);
        if (content && sig.patterns.some((p) => p.test(content))) matches.push('inline script');
      }
      for (const l of page.stylesheets) {
        const href = l.href;
        if (href && sig.patterns.some((p) => p.test(href))) matches.push(href);
      }
      if (sig.patterns.some((p) => p.test(page.html))) matches.push('inline html');
      if (matches.length > 0) {
        found.push({ name: sig.name, confidence: sig.confidence });
        byCategory[sig.category] = [...(byCategory[sig.category] ?? []), sig.name];
        const ev = sig.confidence === 'high' ? evHigh : sig.confidence === 'medium' ? evMed : evLow;
        evidence.push(ev('script', `${sig.name} matched in: ${matches[0]?.slice(0, 100)}`));
      }
    }

    return this.ok({ detected: found, byCategory }, evidence);
  }
}
