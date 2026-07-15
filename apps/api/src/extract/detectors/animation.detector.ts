import { CrawledPage } from '@extractionstack/shared';
import { BaseDetector } from './detector.interface.js';

interface AnimationData {
  keyframes: number;
  cssTransitions: number;
  cssAnimations: number;
  libs: string[];
}

const LIB_SIGNATURES: Array<{ name: string; pattern: RegExp }> = [
  { name: 'gsap', pattern: /gsap|TweenMax|TimelineMax|ScrollTrigger/ },
  { name: 'framer-motion', pattern: /framer-motion|__motion/ },
  { name: 'aos', pattern: /aos-(?:init|item|animate)/ },
  { name: 'anime.js', pattern: /anime\(|anime\.js/ },
  { name: 'lottie', pattern: /lottie-web|bodymovin/ },
];

export class AnimationDetector extends BaseDetector<AnimationData> {
  readonly dimension = 'animation' as const;

  async detect(page: CrawledPage): Promise<import('@extractionstack/shared').DetectorResult<AnimationData>> {
    const keyframes = (page.html.match(/@keyframes\s+\w+/g) ?? []).length;
    const cssTransitions = (page.html.match(/transition\s*:/g) ?? []).length;
    const cssAnimations = (page.html.match(/animation\s*:/g) ?? []).length;
    const libs = LIB_SIGNATURES.filter((s) => s.pattern.test(page.html)).map((s) => s.name);
    return this.ok({ keyframes, cssTransitions, cssAnimations, libs });
  }
}
