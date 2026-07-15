import { CrawledPage } from '@extractionstack/shared';
import { BaseDetector, evHigh, evMed } from './detector.interface.js';

interface ThirdPartyServicesData {
  detected: { name: string; category: string; confidence: 'high' | 'medium' }[];
}

const SIGNATURES: Array<{ name: string; category: string; patterns: RegExp[]; domains?: RegExp[] }> = [
  { name: 'stripe', category: 'payments', patterns: [/stripe\.com\/v\d|@stripe\/stripe-js|Stripe\(/], domains: [/\.stripe\.com/, /stripe-network/] },
  { name: 'paypal', category: 'payments', patterns: [/paypal\.com|@paypal/], domains: [/\.paypal\.com/, /paypalobjects\.com/] },
  { name: 'mercadopago', category: 'payments', patterns: [/mercadopago|mercadolibre/], domains: [/\.mercadopago\.com/] },
  { name: 'intercom', category: 'support', patterns: [/intercom\.io|Intercom\(/], domains: [/widget\.intercom\.io/, /api-iam\.intercom\.io/] },
  { name: 'zendesk', category: 'support', patterns: [/zendesk\.com|zE\(/], domains: [/\.zendesk\.com/] },
  { name: 'segment', category: 'analytics-cdp', patterns: [/analytics\.js|segment\.com\/analytics\.js|@segment/], domains: [/cdn\.segment\.com/] },
  { name: 'sentry', category: 'observability', patterns: [/@sentry|Sentry\.init/], domains: [/\.sentry\.io/, /ingest\.us\.sentry\.io/] },
  { name: 'datadog', category: 'observability', patterns: [/datadoghq\.com|DD_RUM/], domains: [/\.datadoghq\.com/] },
  { name: 'hotjar', category: 'analytics', patterns: [/static\.hotjar\.com|hotjar\.com\/c\.js/], domains: [/static\.hotjar\.com/, /vars\.hotjar\.com/] },
  { name: 'fullstory', category: 'analytics', patterns: [/fullstory\.com|edge\.fullstory\.com/], domains: [/edge\.fullstory\.com/] },
  { name: 'logrocket', category: 'observability', patterns: [/cdn\.logrocket\.com|LogRocket\.init/], domains: [/r\.logrocket\.io/] },
  { name: 'cloudflare-turnstile', category: 'captcha', patterns: [/challenges\.cloudflare\.com|turnstile/], domains: [/challenges\.cloudflare\.com/] },
  { name: 'recaptcha', category: 'captcha', patterns: [/google\.com\/recaptcha|grecaptcha/], domains: [/www\.google\.com\/recaptcha/] },
  { name: 'hcaptcha', category: 'captcha', patterns: [/hcaptcha\.com/], domains: [/js\.hcaptcha\.com/] },
  { name: 'mapbox', category: 'maps', patterns: [/mapbox-gl|api\.mapbox\.com/], domains: [/api\.mapbox\.com/] },
  { name: 'google-maps', category: 'maps', patterns: [/maps\.googleapis\.com|google\.maps/], domains: [/maps\.googleapis\.com/] },
  { name: 'youtube-embed', category: 'media', patterns: [/youtube\.com\/embed|youtube-nocookie\.com/], domains: [/youtube\.com/, /ytimg\.com/] },
  { name: 'vimeo-embed', category: 'media', patterns: [/player\.vimeo\.com/], domains: [/player\.vimeo\.com/] },
  { name: 'twilio', category: 'comms', patterns: [/twilio\.com|@twilio/], domains: [/\.twilio\.com/] },
  { name: 'sendgrid', category: 'comms', patterns: [/sendgrid\.com/], domains: [/\.sendgrid\.com/] },
];

export class ThirdPartyServicesDetector extends BaseDetector<ThirdPartyServicesData> {
  readonly dimension = 'thirdPartyServices' as const;

  async detect(page: CrawledPage): Promise<import('@extractionstack/shared').DetectorResult<ThirdPartyServicesData>> {
    const found = new Map<string, { name: string; category: string; confidence: 'high' | 'medium' }>();
    const evidence: import('@extractionstack/shared').Evidence[] = [];

    for (const sig of SIGNATURES) {
      for (const s of page.scripts) {
        const blob = (s.src ?? '') + ' ' + (s.content ?? '');
        if (sig.patterns.some((p) => p.test(blob))) {
          found.set(sig.name, { name: sig.name, category: sig.category, confidence: 'high' });
          evidence.push(evHigh('script', `${sig.name} script: ${(s.src ?? 'inline').slice(0, 80)}`));
          break;
        }
      }
      if (found.has(sig.name)) continue;
      for (const n of page.networkLog) {
        if (sig.domains?.some((d) => d.test(n.url))) {
          found.set(sig.name, { name: sig.name, category: sig.category, confidence: 'high' });
          evidence.push(evHigh('network', `request to ${n.url.slice(0, 80)}`));
          break;
        }
      }
      if (found.has(sig.name)) continue;
      if (sig.patterns.some((p) => p.test(page.html))) {
        found.set(sig.name, { name: sig.name, category: sig.category, confidence: 'medium' });
        evidence.push(evMed('html', `${sig.name} marker in HTML`));
      }
    }

    return this.ok({ detected: Array.from(found.values()) }, evidence);
  }
}
