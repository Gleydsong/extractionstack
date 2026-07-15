import type { CrawledPage } from '@extractionstack/shared';
import { BaseDetector, evHigh } from './detector.interface.js';

interface ReverseProxyData {
  detected: string[];
  primary: string | null;
  signals: { provider: string; snippet: string; confidence: 'high' | 'medium' }[];
}

const SIGNATURES: Array<{ name: string; patterns?: RegExp[]; headerSignals: RegExp[] }> = [
  { name: 'nginx', headerSignals: [/server:\s*nginx/i, /x-nginx/i] },
  { name: 'apache', headerSignals: [/server:\s*Apache/i] },
  { name: 'caddy', headerSignals: [/server:\s*Caddy/i] },
  { name: 'traefik', headerSignals: [/server:\s*Traefik/i, /x-traefik-/i] },
  { name: 'haproxy', headerSignals: [/server:\s*HAProxy/i] },
  { name: 'cloudflare-proxy', headerSignals: [/cf-ray/i, /cf-cache-status/i, /server:\s*cloudflare/i] },
  { name: 'akamai-ghost', headerSignals: [/x-akamai-/i, /server:\s*AkamaiGHost/i] },
  { name: 'envoy', headerSignals: [/server:\s*envoy/i, /x-envoy-/i, /x-request-id/i] },
  { name: 'gcp-load-balancer', headerSignals: [/via:\s*1\.1 google/i, /server:\s*GFE/i] },
];

export class ReverseProxyDetector extends BaseDetector<ReverseProxyData> {
  readonly dimension = 'reverseProxy' as const;

  async detect(page: CrawledPage): Promise<import('@extractionstack/shared').DetectorResult<ReverseProxyData>> {
    const signals: ReverseProxyData['signals'] = [];
    const evidence: import('@extractionstack/shared').Evidence[] = [];
    const allHeaders: string[] = [];
    for (const [k, v] of Object.entries(page.headers)) allHeaders.push(`${k}: ${v}`);
    for (const n of page.networkLog) {
      if (n.responseHeaders) {
        for (const [k, v] of Object.entries(n.responseHeaders)) allHeaders.push(`${k}: ${v}`);
      }
    }
    const headerBlob = allHeaders.join('\n');

    for (const sig of SIGNATURES) {
      const match = headerBlob.split('\n').find((line) => sig.headerSignals.some((p) => p.test(line)));
      if (match) {
        const conf = sig.name === 'cloudflare-proxy' || sig.name === 'gcp-load-balancer' ? 'high' : 'high';
        signals.push({ provider: sig.name, snippet: match, confidence: conf });
        evidence.push(evHigh('header', `${sig.name}: ${match.slice(0, 80)}`));
      }
    }

    const detected = Array.from(new Set(signals.map((s) => s.provider)));
    return this.ok({ detected, primary: detected[0] ?? null, signals }, evidence);
  }
}
