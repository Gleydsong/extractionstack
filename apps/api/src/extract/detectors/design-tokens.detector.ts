import type { CrawledPage } from '@extractionstack/shared';
import { BaseDetector } from './detector.interface.js';

interface DesignTokensData {
  customProperties: { name: string; value: string }[];
  namingConvention: 'kebab' | 'camel' | 'snake' | 'mixed' | 'unknown';
  groups: Record<string, number>;
}

export class DesignTokensDetector extends BaseDetector<DesignTokensData> {
  readonly dimension = 'designTokens' as const;

  async detect(page: CrawledPage): Promise<import('@extractionstack/shared').DetectorResult<DesignTokensData>> {
    const declarationRe = /(--[\w-]+)\s*:\s*([^;}\n]+)/g;
    const seen = new Set<string>();
    const props: { name: string; value: string }[] = [];
    for (const m of page.html.matchAll(declarationRe)) {
      const name = m[1];
      const value = m[2]?.trim();
      if (!name || !value || seen.has(name)) continue;
      seen.add(name);
      props.push({ name, value });
      if (props.length >= 200) break;
    }

    const naming = this.detectNaming(props.map((p) => p.name));
    const groups: Record<string, number> = {};
    for (const p of props) {
      const prefix = p.name.replace(/^--/, '').split('-')[0] ?? 'other';
      groups[prefix] = (groups[prefix] ?? 0) + 1;
    }

    return this.ok({ customProperties: props, namingConvention: naming, groups });
  }

  private detectNaming(names: string[]): DesignTokensData['namingConvention'] {
    if (names.length === 0) return 'unknown';
    let kebab = 0;
    let camel = 0;
    let snake = 0;
    for (const n of names) {
      const stripped = n.replace(/^--/, '');
      if (stripped.includes('-')) kebab++;
      else if (/[A-Z]/.test(stripped)) camel++;
      else if (stripped.includes('_')) snake++;
    }
    const total = names.length;
    if (kebab / total > 0.7) return 'kebab';
    if (camel / total > 0.7) return 'camel';
    if (snake / total > 0.7) return 'snake';
    return 'mixed';
  }
}
