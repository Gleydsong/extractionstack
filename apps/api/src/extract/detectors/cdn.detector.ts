import { CrawledPage } from '@extractionstack/shared';
import { BaseDetector, evHigh, evMed } from './detector.interface.js';

interface CdnData {
  detected: string[];
  primary: string | null;
  signals: { provider: string; snippet: string; confidence: 'high' | 'medium' }[];
}

const SIGNATURES: Array<{ name: string; patterns?: RegExp[]; domains?: RegExp[]; headerSignals?: RegExp[] }> = [
  {
    name: 'cloudflare',
    patterns: [/cloudflareinsights\.com/],
    domains: [/\.cloudflare\.com/, /cloudflareinsights\.com/, /cdnjs\.cloudflare\.com/],
    headerSignals: [/cloudflare/i, /cf-ray/i],
  },
  {
    name: 'fastly',
    domains: [/\.fastly\.net/, /fastly\.com/],
    headerSignals: [/fastly/i, /x-served-by.*cache-/i, /x-fastly-request-id/i],
  },
  {
    name: 'cloudfront',
    domains: [/\.cloudfront\.net/],
    headerSignals: [/x-amz-cf-id/i, /via.*CloudFront/i],
  },
  {
    name: 'akamai',
    domains: [/\.akamaihd\.net/, /akamaiedge\.net/],
    headerSignals: [/akamai/i, /x-akamai-/i],
  },
  {
    name: 'bunny',
    domains: [/\.b-cdn\.net/, /bunny\.net/],
  },
  {
    name: 'vercel-edge',
    domains: [/edge\.vercel\.com/, /vercel-storage\.com/],
    headerSignals: [/x-vercel-/i],
  },
  {
    name: 'netlify',
    domains: [/\.netlify\.com/, /netlify\.app/],
    headerSignals: [/x-nf-/i, /server: Netlify/i],
  },
  {
    name: 'incapsula',
    headerSignals: [/incapsula/i, /x-iinfo/i],
  },
];

export class CdnDetector extends BaseDetector<CdnData> {
  readonly dimension = 'cdn' as const;

  async detect(page: CrawledPage): Promise<import('@extractionstack/shared').DetectorResult<CdnData>> {
    const signals: CdnData['signals'] = [];
    const evidence: import('@extractionstack/shared').Evidence[] = [];
    const allHeaders: string[] = [];
    for (const [k, v] of Object.entries(page.headers)) {
      allHeaders.push(`${k}: ${v}`);
    }
    for (const n of page.networkLog) {
      if (n.responseHeaders) {
        for (const [k, v] of Object.entries(n.responseHeaders)) {
          allHeaders.push(`${k}: ${v}`);
        }
      }
    }
    const headerBlob = allHeaders.join('\n');

    for (const sig of SIGNATURES) {
      let matched = false;
      for (const s of page.scripts) {
        const src = s.src;
        if (src && sig.patterns?.some((p) => p.test(src))) {
          signals.push({ provider: sig.name, snippet: src, confidence: 'high' });
          evidence.push(evHigh('script', `${sig.name} script: ${src.slice(0, 80)}`));
          matched = true;
          break;
        }
      }
      if (!matched) {
        for (const n of page.networkLog) {
          if (sig.domains?.some((d) => d.test(n.url))) {
            signals.push({ provider: sig.name, snippet: n.url, confidence: 'high' });
            evidence.push(evHigh('network', `${sig.name} request: ${n.url.slice(0, 80)}`));
            matched = true;
            break;
          }
        }
      }
      if (!matched && sig.headerSignals?.some((p) => p.test(headerBlob))) {
        const snippetMatch = headerBlob.split('\n').find((line) => sig.headerSignals!.some((p) => p.test(line)));
        signals.push({ provider: sig.name, snippet: snippetMatch ?? '', confidence: 'medium' });
        evidence.push(evMed('header', `${sig.name} header match: ${(snippetMatch ?? '').slice(0, 80)}`));
      }
    }

    const detected = Array.from(new Set(signals.map((s) => s.provider)));
    return this.ok({ detected, primary: detected[0] ?? null, signals }, evidence);
  }
}
