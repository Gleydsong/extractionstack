import type { CrawledPage } from '@extractionstack/shared';
import { BaseDetector, evHigh, evMed } from './detector.interface.js';

interface CloudProviderData {
  detected: string[];
  primary: string | null;
  signals: { provider: string; snippet: string; confidence: 'high' | 'medium' }[];
}

const SIGNATURES: Array<{
  name: string;
  patterns: RegExp[];
  domains?: RegExp[];
  headerSignals?: RegExp[];
}> = [
  {
    name: 'vercel',
    patterns: [/vercel\.com|Vercel-Analytics/],
    domains: [/vercel\.com/, /vercel\.app/],
    headerSignals: [/x-vercel-/i, /server:\s*Vercel/i],
  },
  {
    name: 'netlify',
    patterns: [/netlify\.com|netlify-cms/],
    domains: [/netlify\.com/, /netlify\.app/],
    headerSignals: [/server:\s*Netlify/i, /x-nf-/i],
  },
  {
    name: 'aws',
    patterns: [/amazonaws\.com|aws-sdk/],
    domains: [/\.amazonaws\.com/, /\.aws\.amazon\.com/],
    headerSignals: [/x-amz-/i, /server:\s*AmazonS3/i, /via:\s*AmazonS3/i],
  },
  {
    name: 'gcp',
    patterns: [/googleapis\.com|gcloud/],
    domains: [/\.googleapis\.com/, /\.appspot\.com/, /run\.app/],
    headerSignals: [/x-goog-/i, /server:\s*GSE/i, /via:\s*1\.1 google/i],
  },
  {
    name: 'azure',
    patterns: [/azurewebsites\.net|azure-api\.net/],
    domains: [/azurewebsites\.net/, /\.azure-api\.net/, /\.azureedge\.net/, /\.cloudapp\.azure\.com/],
    headerSignals: [/x-azure-/i, /server:\s*Windows-Azure/i],
  },
  {
    name: 'cloudflare-pages',
    patterns: [/pages\.dev/],
    domains: [/\.pages\.dev/],
  },
  {
    name: 'fly',
    patterns: [/fly\.io/],
    domains: [/\.fly\.dev/, /fly\.io/],
    headerSignals: [/server:\s*Fly/i, /x-fly-/i],
  },
  {
    name: 'render',
    patterns: [/onrender\.com/],
    domains: [/\.onrender\.com/],
    headerSignals: [/server:\s*Render/i, /x-render-/i],
  },
  {
    name: 'heroku',
    patterns: [/herokuapp\.com/],
    domains: [/\.herokuapp\.com/],
    headerSignals: [/via:\s*1\.1 vegur/i, /server:\s*Cowboy/i],
  },
  {
    name: 'digitalocean',
    patterns: [/digitaloceanspaces\.com/],
    domains: [/digitaloceanspaces\.com/],
  },
];

export class CloudProviderDetector extends BaseDetector<CloudProviderData> {
  readonly dimension = 'cloudProvider' as const;

  async detect(page: CrawledPage): Promise<import('@extractionstack/shared').DetectorResult<CloudProviderData>> {
    const signals: CloudProviderData['signals'] = [];
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
        if (sig.patterns.some((p) => p.test(s.src ?? ''))) {
          signals.push({ provider: sig.name, snippet: s.src ?? '', confidence: 'high' });
          evidence.push(evHigh('script', `${sig.name} script: ${(s.src ?? '').slice(0, 80)}`));
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
        evidence.push(evMed('header', `${sig.name} header: ${(snippetMatch ?? '').slice(0, 80)}`));
      }
    }

    const detected = Array.from(new Set(signals.map((s) => s.provider)));
    return this.ok({ detected, primary: detected[0] ?? null, signals }, evidence);
  }
}
