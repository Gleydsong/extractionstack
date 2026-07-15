import type { CrawledPage } from '@extractionstack/shared';
import { BaseDetector, evMed } from './detector.interface.js';

interface IconsData {
  inlineSvgCount: number;
  libraries: string[];
  totalIcons: number;
}

const LIB_SIGNATURES: Array<{ name: string; patterns: RegExp[] }> = [
  { name: 'lucide', patterns: [/lucide/, /data-lucide/] },
  { name: 'heroicons', patterns: [/heroicons/, /data-heroicons/] },
  { name: 'font-awesome', patterns: [/font-?awesome/, /fa-[\w-]+/, /class="[^"]*\bfa\b/] },
  { name: 'material-icons', patterns: [/material-icons/, /material-symbols/] },
  { name: 'feather', patterns: [/feather-icons/, /data-feather/] },
  { name: 'tabler', patterns: [/tabler-icons/, /data-tabler/] },
  { name: 'phosphor', patterns: [/phosphor-icons/, /data-phosphor/] },
  { name: 'react-icons', patterns: [/react-icons/] },
];

export class IconsDetector extends BaseDetector<IconsData> {
  readonly dimension = 'icons' as const;

  async detect(page: CrawledPage): Promise<import('@extractionstack/shared').DetectorResult<IconsData>> {
    const inlineSvgCount = (page.html.match(/<svg\b/gi) ?? []).length;
    const libraries = LIB_SIGNATURES.filter((s) => s.patterns.some((p) => p.test(page.html))).map(
      (s) => s.name,
    );
    const faIcons = (page.html.match(/\bfa-[\w-]+/g) ?? []).length;
    const totalIcons = inlineSvgCount + faIcons;
    const evidence = libraries.map((name) => evMed('html', name, 'icon library marker'));
    if (inlineSvgCount > 0) evidence.push(evMed('html', `<svg> x${inlineSvgCount}`));
    return this.ok({ inlineSvgCount, libraries, totalIcons }, evidence);
  }
}
