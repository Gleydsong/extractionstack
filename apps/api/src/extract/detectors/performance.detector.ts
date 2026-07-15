import type { CrawledPage } from '@extractionstack/shared';
import { BaseDetector } from './detector.interface.js';

interface PerformanceData {
  firstPaint: number | null;
  firstContentfulPaint: number | null;
  domContentLoaded: number | null;
  load: number | null;
  totalRequests: number;
  totalTransferBytes: number;
  lazyLoadedImages: number;
  totalImages: number;
  preloads: number;
  preconnects: number;
}

export class PerformanceDetector extends BaseDetector<PerformanceData> {
  readonly dimension = 'performance' as const;

  async detect(page: CrawledPage): Promise<import('@extractionstack/shared').DetectorResult<PerformanceData>> {
    const t = page.perfTiming ?? {};
    const totalRequests = page.networkLog.length;
    const totalTransferBytes = page.networkLog.reduce((acc, n) => acc + (n.size ?? 0), 0);
    const imgTags = page.html.match(/<img\b[^>]*>/gi) ?? [];
    const lazyLoadedImages = imgTags.filter((t) => /\bloading\s*=\s*"lazy"/i.test(t)).length;
    const preloads = page.linkRel.filter((l) => l.rel === 'preload').length;
    const preconnects = page.linkRel.filter((l) => l.rel === 'preconnect').length;
    return this.ok({
      firstPaint: t.firstPaint ?? null,
      firstContentfulPaint: t.firstContentfulPaint ?? null,
      domContentLoaded: t.domContentLoaded ?? null,
      load: t.load ?? null,
      totalRequests,
      totalTransferBytes,
      lazyLoadedImages,
      totalImages: imgTags.length,
      preloads,
      preconnects,
    });
  }
}
