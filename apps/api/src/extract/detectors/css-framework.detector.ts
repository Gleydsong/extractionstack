import { CrawledPage } from '@extractionstack/shared';
import { BaseDetector } from './detector.interface.js';

interface CssFrameworkData {
  detected: string[];
  primary: string | null;
  evidence: Record<string, number>;
}

const SIGNATURES: Array<{ name: string; patterns: RegExp[] }> = [
  { name: 'tailwind', patterns: [/\bclass="[^"]*\b(?:flex|grid|p-\d|m-\d|text-\w+-\d{2,3})\b/] },
  { name: 'bootstrap', patterns: [/\bclass="[^"]*\b(?:btn|container|row|col-\w+-\d+)\b/] },
  { name: 'bulma', patterns: [/\bclass="[^"]*\b(?:button|columns|column|notification)\b/] },
  { name: 'tachyons', patterns: [/\bclass="[^"]*\b(?:f[1-6]|pa[0-9]|ma[0-9]|bg-\w+)\b/] },
  { name: 'foundation', patterns: [/\bclass="[^"]*\b(?:grid-x|cell|button|reveal)\b/] },
];

export class CssFrameworkDetector extends BaseDetector<CssFrameworkData> {
  readonly dimension = 'cssFramework' as const;

  async detect(page: CrawledPage): Promise<import('@extractionstack/shared').DetectorResult<CssFrameworkData>> {
    const evidence: Record<string, number> = {};
    for (const sig of SIGNATURES) {
      let hits = 0;
      for (const p of sig.patterns) if (p.test(page.html)) hits++;
      if (hits > 0) evidence[sig.name] = hits;
    }
    if (Object.keys(evidence).length === 0) {
      return this.ok({ detected: [], primary: null, evidence: {} });
    }
    const detected = Object.keys(evidence).sort((a, b) => (evidence[b] ?? 0) - (evidence[a] ?? 0));
    return this.ok({ detected, primary: detected[0] ?? null, evidence });
  }
}
