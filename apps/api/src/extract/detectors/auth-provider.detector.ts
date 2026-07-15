import { CrawledPage } from '@extractionstack/shared';
import { BaseDetector, evHigh, evMed } from './detector.interface.js';

interface AuthProviderData {
  detected: string[];
  primary: string | null;
  signals: { provider: string; snippet: string; confidence: 'high' | 'medium' }[];
}

const SIGNATURES: Array<{ name: string; patterns: RegExp[]; domains?: RegExp[] }> = [
  {
    name: 'auth0',
    patterns: [/auth0|@auth0\/|Auth0Provider/],
    domains: [/\.auth0\.com/, /\.eu\.auth0\.com/],
  },
  {
    name: 'firebase-auth',
    patterns: [/firebase\/auth|firebase\.auth\(\)|firebase-app\.js/],
    domains: [/firestore\.googleapis\.com/, /identitytoolkit\.googleapis\.com/],
  },
  {
    name: 'supabase',
    patterns: [/supabase|supabase-js|@supabase\/auth-helpers/],
    domains: [/\.supabase\.co/],
  },
  {
    name: 'clerk',
    patterns: [/\.clerk\.accounts\.dev|@clerk\/|clerk\.frontendApi/],
    domains: [/clerk\.accounts\.dev/, /clerk\.com/],
  },
  {
    name: 'nextauth',
    patterns: [/next-auth|NextAuth\(/],
  },
  {
    name: 'auth.js',
    patterns: [/\.@auth\/core|@auth/],
  },
  {
    name: 'okta',
    patterns: [/\bokta\.com|@okta\/okta-auth-js/],
    domains: [/\.okta\.com/, /\.oktacdn\.com/],
  },
  {
    name: 'cognito',
    patterns: [/amazoncognito\.com|cognito-identity/],
    domains: [/cognito-idp\..*\.amazonaws\.com/],
  },
  {
    name: 'magic-link',
    patterns: [/magic-sdk|@magic-sdk\/|Magic\./],
  },
  {
    name: 'walletconnect',
    patterns: [/walletconnect|@walletconnect\//],
  },
  {
    name: 'metamask',
    patterns: [/ethereum\.request|window\.ethereum|@metamask\//],
  },
];

export class AuthProviderDetector extends BaseDetector<AuthProviderData> {
  readonly dimension = 'authProvider' as const;

  async detect(page: CrawledPage): Promise<import('@extractionstack/shared').DetectorResult<AuthProviderData>> {
    const signals: AuthProviderData['signals'] = [];
    const evidence: import('@extractionstack/shared').Evidence[] = [];

    for (const sig of SIGNATURES) {
      let matched = false;
      for (const s of page.scripts) {
        const blob = (s.src ?? '') + ' ' + (s.content ?? '');
        if (sig.patterns.some((p) => p.test(blob))) {
          signals.push({
            provider: sig.name,
            snippet: (s.src ?? 'inline').slice(0, 100),
            confidence: 'high',
          });
          evidence.push(evHigh('script', `${sig.name} script: ${(s.src ?? 'inline').slice(0, 80)}`));
          matched = true;
          break;
        }
      }
      if (!matched) {
        for (const n of page.networkLog) {
          if (sig.domains?.some((d) => d.test(n.url))) {
            signals.push({ provider: sig.name, snippet: n.url, confidence: 'high' });
            evidence.push(evHigh('network', `request to ${n.url.slice(0, 80)}`));
            matched = true;
            break;
          }
        }
      }
      if (!matched && sig.patterns.some((p) => p.test(page.html))) {
        signals.push({ provider: sig.name, snippet: 'inline html', confidence: 'medium' });
        evidence.push(evMed('html', `${sig.name} marker in HTML`));
      }
    }

    const detected = Array.from(new Set(signals.map((s) => s.provider)));
    return this.ok({ detected, primary: detected[0] ?? null, signals }, evidence);
  }
}
