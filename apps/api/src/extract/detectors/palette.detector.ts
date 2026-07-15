import type { CrawledPage } from '@extractionstack/shared';
import { BaseDetector, evMed } from './detector.interface.js';

interface PaletteData {
  backgroundColors: string[];
  textColors: string[];
  borderColors: string[];
  sample: { selector: string; background: string; color: string }[];
}

function normalizeColor(c: string): string {
  return c.trim().toLowerCase();
}

export class PaletteDetector extends BaseDetector<PaletteData> {
  readonly dimension = 'palette' as const;

  async detect(page: CrawledPage): Promise<import('@extractionstack/shared').DetectorResult<PaletteData>> {
    const backgrounds = new Set<string>();
    const colors = new Set<string>();
    const borders = new Set<string>();
    const sample = page.computedStyles.map((s) => {
      const bg = s.styles['background-color'];
      const c = s.styles['color'];
      if (bg && bg !== 'rgba(0, 0, 0, 0)') backgrounds.add(normalizeColor(bg));
      if (c) colors.add(normalizeColor(c));
      return { selector: s.selector, background: bg ?? '', color: c ?? '' };
    });
    for (const m of page.html.matchAll(/border(?:-[a-z]+)?\s*:\s*[^;]*?(#[\w()]+|rgba?\([^)]+\))/gi)) {
      if (m[1]) borders.add(normalizeColor(m[1]));
    }
    const backgroundColors = Array.from(backgrounds).slice(0, 30);
    const textColors = Array.from(colors).slice(0, 30);
    const borderColors = Array.from(borders).slice(0, 30);
    const evidence = [
      ...backgroundColors.slice(0, 5).map((color) => evMed('computedStyle', `background-color: ${color}`)),
      ...textColors.slice(0, 5).map((color) => evMed('computedStyle', `color: ${color}`)),
    ];
    return this.ok({ backgroundColors, textColors, borderColors, sample }, evidence);
  }
}
