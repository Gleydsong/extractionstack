import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@extractionstack/shared';
import { ROLES_KEY } from './roles.decorator.js';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const { user } = ctx.switchToHttp().getRequest<{ user?: { roles?: UserRole[] } }>();
    const userRoles = user?.roles ?? [];
    if (!required.some((r) => userRoles.includes(r))) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'insufficient role' });
    }
    return true;
  }
}
