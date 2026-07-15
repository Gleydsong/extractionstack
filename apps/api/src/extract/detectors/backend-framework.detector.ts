import { CrawledPage } from '@extractionstack/shared';
import { BaseDetector, evHigh, evMed, evLow } from './detector.interface.js';

interface BackendFrameworkData {
  detected: string[];
  primary: string | null;
  language: string[];
  server: string | null;
  poweredBy: string | null;
}

const HEADER_SIGNATURES: Array<{
  name: string;
  header: string;
  patterns: RegExp[];
  language?: string;
}> = [
  { name: 'express', header: 'X-Powered-By', patterns: [/Express/i], language: 'JavaScript/TypeScript' },
  { name: 'next.js', header: 'X-Powered-By', patterns: [/Next\.js/i], language: 'JavaScript/TypeScript' },
  { name: 'nuxt', header: 'X-Powered-By', patterns: [/Nuxt/i], language: 'JavaScript/TypeScript' },
  { name: 'php', header: 'X-Powered-By', patterns: [/PHP\//i], language: 'PHP' },
  { name: 'asp.net', header: 'X-Powered-By', patterns: [/ASP\.NET/i], language: 'C#' },
  { name: 'phoenix', header: 'X-Powered-By', patterns: [/Phoenix/i], language: 'Elixir' },
  { name: 'nginx', header: 'Server', patterns: [/nginx/i] },
  { name: 'apache', header: 'Server', patterns: [/Apache/i] },
  { name: 'caddy', header: 'Server', patterns: [/Caddy/i] },
  { name: 'cloudflare', header: 'Server', patterns: [/cloudflare/i] },
  { name: 'gunicorn', header: 'Server', patterns: [/gunicorn/i], language: 'Python' },
  { name: 'uvicorn', header: 'Server', patterns: [/uvicorn/i], language: 'Python' },
  { name: 'werkzeug', header: 'Server', patterns: [/Werkzeug/i], language: 'Python' },
  { name: 'puma', header: 'Server', patterns: [/puma/i], language: 'Ruby' },
  { name: 'unicorn', header: 'Server', patterns: [/unicorn/i], language: 'Ruby' },
];

const COOKIE_SIGNATURES: Array<{ name: string; pattern: RegExp; language?: string }> = [
  { name: 'laravel', pattern: /laravel_session|XSRF-TOKEN/, language: 'PHP' },
  { name: 'rails', pattern: /_session_id|_myapp_session/, language: 'Ruby' },
  { name: 'django', pattern: /csrftoken|sessionid/, language: 'Python' },
  { name: 'express', pattern: /connect\.sid/, language: 'JavaScript/TypeScript' },
  { name: 'symfony', pattern: /PHPSESSID/, language: 'PHP' },
  { name: 'java', pattern: /JSESSIONID/, language: 'Java' },
  { name: 'asp.net', pattern: /ASPSESSIONID|ASP\.NET_SessionId/, language: 'C#' },
];

export class BackendFrameworkDetector extends BaseDetector<BackendFrameworkData> {
  readonly dimension = 'backendFramework' as const;

  async detect(page: CrawledPage): Promise<import('@extractionstack/shared').DetectorResult<BackendFrameworkData>> {
    const detected = new Set<string>();
    const languages = new Set<string>();
    const evidence: import('@extractionstack/shared').Evidence[] = [];

    const server = page.headers['server'] ?? null;
    const poweredBy = page.headers['x-powered-by'] ?? null;

    if (server) {
      for (const sig of HEADER_SIGNATURES.filter((s) => s.header === 'Server')) {
        if (sig.patterns.some((p) => p.test(server))) {
          detected.add(sig.name);
          if (sig.language) languages.add(sig.language);
          evidence.push(evHigh('header', `Server: ${server}`, `matches ${sig.name}`));
        }
      }
    }
    if (poweredBy) {
      for (const sig of HEADER_SIGNATURES.filter((s) => s.header === 'X-Powered-By')) {
        if (sig.patterns.some((p) => p.test(poweredBy))) {
          detected.add(sig.name);
          if (sig.language) languages.add(sig.language);
          evidence.push(evHigh('header', `X-Powered-By: ${poweredBy}`, `matches ${sig.name}`));
        }
      }
    }

    for (const cookie of page.cookies) {
      for (const sig of COOKIE_SIGNATURES) {
        if (sig.pattern.test(cookie.name)) {
          detected.add(sig.name);
          if (sig.language) languages.add(sig.language);
          evidence.push(evMed('cookie', `cookie name "${cookie.name}"`, `matches ${sig.name}`));
          break;
        }
      }
    }

    if (detected.size === 0) {
      if (server) evidence.push(evLow('header', `Server: ${server}`, 'no known signature matched'));
      return this.ok(
        { detected: [], primary: null, language: [], server, poweredBy },
        evidence,
      );
    }
    return this.ok(
      {
        detected: Array.from(detected),
        primary: Array.from(detected)[0] ?? null,
        language: Array.from(languages),
        server,
        poweredBy,
      },
      evidence,
    );
  }
}
