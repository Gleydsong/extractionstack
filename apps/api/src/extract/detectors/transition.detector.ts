import { CrawledPage } from '@extractionstack/shared';
import { BaseDetector } from './detector.interface.js';

interface TransitionData {
  viewTransitionsApi: boolean;
  libs: string[];
  cssTransitionCount: number;
}

const LIB_SIGNATURES: Array<{ name: string; pattern: RegExp }> = [
  { name: 'framer-motion-AnimatePresence', pattern: /AnimatePresence/ },
  { name: 'react-transition-group', pattern: /react-transition-group|TransitionGroup/ },
  { name: 'react-router-transition', pattern: /react-router-transition/ },
  { name: 'next-page-transitions', pattern: /next-page-transitions/ },
];

export class TransitionDetector extends BaseDetector<TransitionData> {
  readonly dimension = 'transition' as const;

  async detect(page: CrawledPage): Promise<import('@extractionstack/shared').DetectorResult<TransitionData>> {
    const viewTransitionsApi = /document\.startViewTransition/.test(page.html);
    const libs = LIB_SIGNATURES.filter((s) => s.pattern.test(page.html)).map((s) => s.name);
    const cssTransitionCount = (page.html.match(/\btransition\s*:/g) ?? []).length;
    return this.ok({ viewTransitionsApi, libs, cssTransitionCount });
  }
}
