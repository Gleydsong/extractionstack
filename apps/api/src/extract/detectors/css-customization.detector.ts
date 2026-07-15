import type { CrawledPage } from '@extractionstack/shared';
import { BaseDetector } from './detector.interface.js';

interface CssCustomizationData {
  customProperties: string[];
  cssInJs: { runtime: string[]; serialized: number };
  overrideCount: number;
}

const RUNTIME_MARKERS: Array<{ runtime: string; pattern: RegExp }> = [
  { runtime: 'styled-components', pattern: /data-styled/ },
  { runtime: 'emotion', pattern: /data-emotion/ },
  { runtime: 'stitches', pattern: /data-stitches/ },
  { runtime: 'goober', pattern: /data-goober/ },
  { runtime: 'vanilla-extract', pattern: /__vanilla_extract/ },
];

export class CssCustomizationDetector extends BaseDetector<CssCustomizationData> {
  readonly dimension = 'cssCustomization' as const;

  async detect(page: CrawledPage): Promise<import('@extractionstack/shared').DetectorResult<CssCustomizationData>> {
    const customPropertyPattern = /--[\w-]+\s*:/g;
    const matches = page.html.match(customPropertyPattern) ?? [];
    const customProperties = Array.from(new Set(matches.map((m) => m.split(':')[0]?.trim() ?? '')))
      .filter(Boolean)
      .slice(0, 50);

    const runtime: string[] = [];
    for (const { runtime: name, pattern } of RUNTIME_MARKERS) {
      if (pattern.test(page.html)) runtime.push(name);
    }

    const serializedMatches = page.html.match(/<style[^>]*>[\s\S]*?--[\w-]+[\s\S]*?<\/style>/g) ?? [];
    const overrideCount = (page.html.match(/:root\s*{/g) ?? []).length;

    return this.ok({
      customProperties,
      cssInJs: { runtime, serialized: serializedMatches.length },
      overrideCount,
    });
  }
}
