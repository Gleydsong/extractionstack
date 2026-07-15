import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Auth0User } from '@extractionstack/shared';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') implements CanActivate {
  override canActivate(context: ExecutionContext) {
    if (
      process.env.AUTH_DEV_MODE === 'true' &&
      process.env.NODE_ENV !== 'production'
    ) {
      const req = context.switchToHttp().getRequest<{ user?: Auth0User }>();
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
