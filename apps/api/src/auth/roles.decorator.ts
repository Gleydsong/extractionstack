import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '@extractionstack/shared';

export const ROLES_KEY = 'extractionstack.roles';
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
