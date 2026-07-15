import type { CrawledPage } from '@extractionstack/shared';
import { BaseDetector, evMed } from './detector.interface.js';

interface ResponsiveData {
  viewport: string | null;
  mediaQueries: number;
  containerQueries: number;
}

export class ResponsiveDetector extends BaseDetector<ResponsiveData> {
  readonly dimension = 'responsive' as const;

  async detect(page: CrawledPage): Promise<import('@extractionstack/shared').DetectorResult<ResponsiveData>> {
    const viewport = page.meta.viewport ?? null;
    const mediaQueries = (page.html.match(/@media\s*\(/g) ?? []).length;
    const containerQueries = (page.html.match(/@container\s+/g) ?? []).length;
    const evidence = [];
    if (viewport) evidence.push(evMed('meta', `viewport: ${viewport}`));
    if (mediaQueries > 0) evidence.push(evMed('html', `${mediaQueries} media query marker(s)`));
    if (containerQueries > 0) evidence.push(evMed('html', `${containerQueries} container query marker(s)`));
    return this.ok({ viewport, mediaQueries, containerQueries }, evidence);
  }
}
