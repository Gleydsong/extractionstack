import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Auth0User } from '@extractionstack/shared';

/**
 * Validates a Bearer JWT via the registered 'jwt' passport strategy (which
 * understands both local HS256 tokens and the legacy Auth0 RS256 tokens).
 *
 * In dev mode, requests that omit the Authorization header (or present the
 * placeholder `dev-token`) get a synthetic dev user without going through
 * the database. Any other token is validated normally so the new local
 * /auth/login flow works in dev too.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') implements CanActivate {
  override canActivate(context: ExecutionContext) {
    const isDev = process.env.AUTH_DEV_MODE === 'true' && process.env.NODE_ENV !== 'production';
    const req = context.switchToHttp().getRequest<{ user?: Auth0User; headers: Record<string, string | string[] | undefined> }>();
    const authHeader = req.headers.authorization;
    const token = typeof authHeader === 'string' ? authHeader.replace(/^Bearer\s+/i, '') : '';

    if (isDev && (!token || token === 'dev-token')) {
      req.user = {
        sub: 'dev|local',
        email: 'dev@local',
        name: 'dev',
        roles: ['user'],
      };
      return true;
    }
    return super.canActivate(context) as boolean | Promise<boolean>;
  }
}
