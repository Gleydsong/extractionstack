import { CrawledPage } from '@extractionstack/shared';
import { BaseDetector } from './detector.interface.js';

interface DesignSystemData {
  detected: string[];
  evidence: Record<string, number>;
}

const SIGNATURES: Array<{ name: string; patterns: RegExp[] }> = [
  { name: 'material-ui', patterns: [/MuiButton/, /data-mui-/, /@mui\/material/] },
  { name: 'chakra-ui', patterns: [/chakra-/, /data-chakra/, /@chakra-ui\//] },
  { name: 'ant-design', patterns: [/ant-/, /anticon/, /antd/] },
  { name: 'mantine', patterns: [/mantine-/, /@mantine\//] },
  { name: 'radix', patterns: [/data-radix-/, /@radix-ui\//] },
  { name: 'shadcn', patterns: [/_Button_root/, /shadcn/] },
  { name: 'next-ui', patterns: [/nextui/, /@nextui-org\//] },
  { name: 'blueprint', patterns: [/bp4-/, /@blueprintjs\//] },
];

export class DesignSystemDetector extends BaseDetector<DesignSystemData> {
  readonly dimension = 'designSystem' as const;

  async detect(page: CrawledPage): Promise<import('@extractionstack/shared').DetectorResult<DesignSystemData>> {
    const evidence: Record<string, number> = {};
    for (const sig of SIGNATURES) {
      let hits = 0;
      for (const p of sig.patterns) if (p.test(page.html)) hits++;
      if (hits > 0) evidence[sig.name] = hits;
    }
    if (Object.keys(evidence).length === 0) {
      return this.ok({ detected: [], evidence: {} });
    }
    const detected = Object.keys(evidence).sort((a, b) => (evidence[b] ?? 0) - (evidence[a] ?? 0));
    return this.ok({ detected, evidence });
  }
}
