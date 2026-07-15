import type { CrawledPage } from '@extractionstack/shared';
import { BaseDetector } from './detector.interface.js';

interface GridSystemData {
  displayFlexCount: number;
  displayGridCount: number;
  inlineStyleFlex: number;
  inlineStyleGrid: number;
}

export class GridSystemDetector extends BaseDetector<GridSystemData> {
  readonly dimension = 'gridSystem' as const;

  async detect(page: CrawledPage): Promise<import('@extractionstack/shared').DetectorResult<GridSystemData>> {
    const body = page.computedStyles.find((s) => s.selector === 'body');
    const flex = body?.styles['display'] === 'flex';
    const grid = body?.styles['display'] === 'grid';
    const displayFlexCount = (page.html.match(/display\s*:\s*flex/g) ?? []).length + (flex ? 1 : 0);
    const displayGridCount = (page.html.match(/display\s*:\s*grid/g) ?? []).length + (grid ? 1 : 0);
    const inlineStyleFlex = (page.html.match(/style="[^"]*display\s*:\s*flex/gi) ?? []).length;
    const inlineStyleGrid = (page.html.match(/style="[^"]*display\s*:\s*grid/gi) ?? []).length;
    return this.ok({ displayFlexCount, displayGridCount, inlineStyleFlex, inlineStyleGrid });
  }
}
