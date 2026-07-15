import type { CrawledPage } from '@extractionstack/shared';
import { BaseDetector } from './detector.interface.js';

interface TypographyData {
  families: string[];
  weights: number[];
  baseSize: string | null;
  scale: { selector: string; size: string }[];
}

export class TypographyDetector extends BaseDetector<TypographyData> {
  readonly dimension = 'typography' as const;

  async detect(page: CrawledPage): Promise<import('@extractionstack/shared').DetectorResult<TypographyData>> {
    const body = page.computedStyles.find((s) => s.selector === 'body');
    const h1 = page.computedStyles.find((s) => s.selector === 'h1');
    const h2 = page.computedStyles.find((s) => s.selector === 'h2');
    const h3 = page.computedStyles.find((s) => s.selector === 'h3');

    const families = Array.from(
      new Set(
        page.computedStyles
          .map((s) => s.styles['font-family'])
          .filter((f): f is string => Boolean(f))
          .map((f) => f.split(',')[0]?.replace(/['"]/g, '').trim() ?? ''),
      ),
    ).filter(Boolean);

    const weights = Array.from(
      new Set(
        page.computedStyles
          .map((s) => Number(s.styles['font-weight']))
          .filter((w) => Number.isFinite(w) && w > 0),
      ),
    ).sort((a, b) => a - b);

    const baseSize = body?.styles['font-size'] ?? null;
    const scale = [h1, h2, h3]
      .filter((x): x is NonNullable<typeof x> => Boolean(x))
      .map((x) => ({ selector: x.selector, size: x.styles['font-size'] ?? '' }));

    return this.ok({ families, weights, baseSize, scale });
  }
}
