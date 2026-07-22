import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';
import type { Auth0User } from '@extractionstack/shared';
import { loadRuntimeEnv } from '../common/runtime-env.js';

interface LocalPayload {
  sub: string;
  email?: string;
  name?: string;
  role?: 'USER' | 'ADMIN';
  provider?: 'local' | 'google' | 'auth0';
}

interface Auth0Payload {
  sub: string;
  email?: string;
  name?: string;
  'https://extractionstack/roles'?: string[];
}

/**
 * Validates HS256 JWTs issued by the local auth module. When AUTH0_DOMAIN is
 * also configured, accepts Auth0 RS256 JWTs as a fallback (so the old flow
 * keeps working if it was previously wired).
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor() {
    const env = loadRuntimeEnv(process.env);
    const auth0Domain = process.env.AUTH0_DOMAIN;
    const auth0Audience = process.env.AUTH0_AUDIENCE;

    const secretOrKeyProvider: any =
      auth0Domain && auth0Audience
        ? passportJwtSecret({
            cache: true,
            rateLimit: true,
            jwksRequestsPerMinute: 10,
            jwksUri: `https://${auth0Domain}/.well-known/jwks.json`,
          })
        : (_req: unknown, _rawJwtToken: unknown, done: (err: unknown, key?: string) => void) => {
            done(null, env.LOCAL_JWT_SECRET);
          };

    super({
      secretOrKeyProvider,
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      // When Auth0 is enabled, both RS256 and HS256 tokens can be presented.
      algorithms: auth0Domain ? ['RS256', 'HS256'] : ['HS256'],
      // No audience check for local JWTs; we sign our own.
      audience: auth0Audience,
      issuer: auth0Domain ? `https://${auth0Domain}/` : undefined,
      ignoreExpiration: false,
    });
  }

  validate(payload: Record<string, unknown> | LocalPayload | Auth0Payload): Auth0User {
    // Auth0 payloads have the namespaced claim; local payloads use a `role` field.
    const isAuth0 =
      'https://extractionstack/roles' in (payload as object) ||
      this.looksLikeAuth0(payload as Record<string, unknown>);
    if (isAuth0) {
      const p = payload as Auth0Payload;
      const roles = p['https://extractionstack/roles'] ?? ['user'];
      return {
        sub: p.sub,
        email: p.email,
        name: p.name,
        roles: roles.includes('admin') ? ['admin'] : ['user'],
      };
    }

    const p = payload as LocalPayload;
    if (!p.sub) throw new UnauthorizedException('invalid token payload');
    return {
      sub: p.sub,
      email: p.email,
      name: p.name,
      roles: p.role === 'ADMIN' ? ['admin'] : ['user'],
    };
  }

  private looksLikeAuth0(payload: Record<string, unknown>): boolean {
    return (
      typeof payload['https://extractionstack/roles'] !== 'undefined' ||
      (typeof payload.iss === 'string' && /\/$/.test(payload.iss) && /auth0/.test(payload.iss))
    );
  }
}
