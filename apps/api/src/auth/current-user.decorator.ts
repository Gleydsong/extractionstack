import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Auth0User } from '@extractionstack/shared';
import type { Request } from 'express';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Auth0User => {
    const req = ctx.switchToHttp().getRequest<Request & { user?: Auth0User }>();
    if (!req.user) {
      throw new Error('CurrentUser used on a route without JwtAuthGuard');
    }
    return req.user;
  },
);
