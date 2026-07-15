import type { CrawledPage } from '@extractionstack/shared';
import { BaseDetector, evMed, evLow } from './detector.interface.js';

interface DatabaseIndicatorsData {
  detected: string[];
  cookies: { name: string; value: string; hint: string }[];
}

const COOKIE_PATTERNS: Array<{ db: string; pattern: RegExp; hint: string }> = [
  { db: 'PostgreSQL/Generic session', pattern: /PHPSESSID/, hint: 'PHP session — likely backend with PHP' },
  { db: 'MySQL/Generic', pattern: /JSESSIONID/, hint: 'Java servlet session' },
  { db: 'ASP.NET', pattern: /ASPSESSIONID|ASP\.NET_SessionId/, hint: 'ASP.NET session' },
  { db: 'Django', pattern: /sessionid|csrftoken/, hint: 'Django session/CSRF' },
  { db: 'Rails', pattern: /_session_id|_myapp_session/, hint: 'Rails session' },
  { db: 'Laravel', pattern: /laravel_session|XSRF-TOKEN/, hint: 'Laravel session' },
  { db: 'Express', pattern: /connect\.sid/, hint: 'Express session middleware' },
  { db: 'NextAuth', pattern: /next-auth\.session-token|__Secure-next-auth/, hint: 'NextAuth session' },
  { db: 'Auth0', pattern: /auth0\.com|appSession|appMetadata/, hint: 'Auth0 session' },
  { db: 'Supabase', pattern: /sb-.*-auth-token/, hint: 'Supabase auth token' },
  { db: 'Clerk', pattern: /__session|__client_uat/, hint: 'Clerk session' },
  { db: 'Firebase', pattern: /firebase.*token|fb_token/, hint: 'Firebase auth token' },
];

export class DatabaseIndicatorsDetector extends BaseDetector<DatabaseIndicatorsData> {
  readonly dimension = 'databaseIndicators' as const;

  async detect(page: CrawledPage): Promise<import('@extractionstack/shared').DetectorResult<DatabaseIndicatorsData>> {
    const detected = new Set<string>();
    const cookies: DatabaseIndicatorsData['cookies'] = [];
    const evidence: import('@extractionstack/shared').Evidence[] = [];

    for (const c of page.cookies) {
      for (const pat of COOKIE_PATTERNS) {
        if (pat.pattern.test(c.name)) {
          detected.add(pat.db);
          cookies.push({ name: c.name, value: c.value.slice(0, 60), hint: pat.hint });
          evidence.push(evMed('cookie', `${c.name} -> ${pat.db} (${pat.hint})`));
          break;
        }
      }
    }

    if (page.headers['set-cookie'] === undefined && page.cookies.length > 0) {
      evidence.push(evLow('cookie', `${page.cookies.length} cookie(s) present`));
    }

    return this.ok({ detected: Array.from(detected), cookies: cookies.slice(0, 20) }, evidence);
  }
}
