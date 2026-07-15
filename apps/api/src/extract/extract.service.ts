import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CrawledPage,
  DetectorResult,
  Dimension,
  ExtractRequest,
  ExtractionReport,
} from '@extractionstack/shared';
import { mapExtractError } from '../common/extract-errors.js';
import { assertSafeTargetUrl } from '../common/url-safety.js';
import { Detector } from './detectors/detector.interface.js';
import { DETECTOR_LIST, DETECTORS_TOKEN, RESPONSIVE_GRID_MERGE_KEY } from './detectors/registry.js';
import { PlaywrightCrawler } from './crawler/playwright-crawler.js';

@Injectable()
export class ExtractService {
  private readonly logger = new Logger(ExtractService.name);

  constructor(
    private readonly crawler: PlaywrightCrawler,
    @Inject(DETECTORS_TOKEN)
    private readonly detectors: Detector[],
  ) {}

  async extract(req: ExtractRequest): Promise<ExtractionReport> {
    const start = Date.now();
    this.logger.log(`extract start url=${req.url}`);

    try {
      await assertSafeTargetUrl(req.url);
      const page = await this.crawler.crawl(req.url);
      const results = await this.runDetectorsSafely(page);
      const merged = this.mergeResponsiveAndGrid(results);
      const sorted = this.sortByDimension(merged);

      const report: ExtractionReport = {
        url: req.url,
        finalUrl: page.finalUrl,
        fetchedAt: page.fetchedAt,
        durationMs: Date.now() - start,
        sections: Object.fromEntries(sorted.map((r) => [r.dimension, r])),
      };
      this.logger.log(`extract done url=${req.url} durationMs=${report.durationMs}`);
      return report;
    } catch (err) {
      mapExtractError(err);
    }
  }

  private async runDetectorsSafely(page: CrawledPage): Promise<DetectorResult[]> {
    const tasks = this.detectors.map(async (d) => {
      try {
        return await d.detect(page);
      } catch (err) {
        this.logger.warn(`detector ${d.dimension} failed: ${(err as Error).message}`);
        return {
          dimension: d.dimension,
          status: 'error' as const,
          error: (err as Error).message,
        };
      }
    });
    return Promise.all(tasks);
  }

  private mergeResponsiveAndGrid(results: DetectorResult[]): DetectorResult[] {
    const responsive = results.find((r) => r.dimension === 'responsive');
    const grid = results.find((r) => r.dimension === 'gridSystem');
    if (!responsive || !grid) return results;
    if (responsive.status !== 'ok' || grid.status !== 'ok') return results;
    const merged: DetectorResult = {
      dimension: RESPONSIVE_GRID_MERGE_KEY,
      status: 'ok',
      data: {
        responsive: responsive.data,
        grid: grid.data,
      },
    };
    return results
      .filter((r) => r.dimension !== 'responsive' && r.dimension !== 'gridSystem')
      .concat(merged);
  }

  private sortByDimension(results: DetectorResult[]): DetectorResult[] {
    const order: Dimension[] = DETECTOR_LIST.map((d) => d.dimension);
    const index = new Map(order.map((d, i) => [d, i] as const));
    return [...results].sort((a, b) => {
      const ai = index.has(a.dimension) ? (index.get(a.dimension) as number) : order.length;
      const bi = index.has(b.dimension) ? (index.get(b.dimension) as number) : order.length;
      return ai - bi;
    });
  }
}
