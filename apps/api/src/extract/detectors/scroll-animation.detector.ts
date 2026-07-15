import type { CrawledPage } from '@extractionstack/shared';
import { BaseDetector } from './detector.interface.js';

interface ScrollAnimationData {
  libs: string[];
  hasDataScroll: boolean;
  hasIntersectionObserver: boolean;
}

const LIB_SIGNATURES: Array<{ name: string; pattern: RegExp }> = [
  { name: 'lenis', pattern: /lenis|__lenis/ },
  { name: 'locomotive-scroll', pattern: /locomotive-scroll|data-scroll/ },
  { name: 'rellax', pattern: /rellax/ },
  { name: 'sal.js', pattern: /sal\(\)/ },
  { name: 'scrollmagic', pattern: /ScrollMagic/ },
];

export class ScrollAnimationDetector extends BaseDetector<ScrollAnimationData> {
  readonly dimension = 'scrollAnimation' as const;

  async detect(page: CrawledPage): Promise<import('@extractionstack/shared').DetectorResult<ScrollAnimationData>> {
    const libs = LIB_SIGNATURES.filter((s) => s.pattern.test(page.html)).map((s) => s.name);
    const hasDataScroll = /\bdata-scroll\b/i.test(page.html);
    const hasIntersectionObserver =
      /IntersectionObserver/.test(page.html) ||
      page.scripts.some((s) => (s.content ?? '').includes('IntersectionObserver'));
    return this.ok({ libs, hasDataScroll, hasIntersectionObserver });
  }
}
