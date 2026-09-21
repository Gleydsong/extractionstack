import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { AuthLocalController } from './auth-local.controller.js';
import { AuthLocalService } from './auth-local.service.js';
import { GoogleStrategy } from './google.strategy.js';

/**
 * Guards that the auth-local module composes: the controller and service are
 * resolvable when their leaf dependencies (Prisma, JWT, Google strategy) are
 * provided. Leaf tokens are mocked; the auth-local classes are the real ones.
 *
 * NOTE: the explicit `@Inject(...)` decorators in auth-local are load-bearing,
 * not redundant. With `emitDecoratorMetadata`, a class imported via `import type`
 * compiles to `design:paramtypes: [Function]`, which Nest cannot resolve. Removing
 * the decorators while satisfying `@typescript-eslint/consistent-type-imports`
 * breaks production DI (verified via `nest build`). See handoff.
 */
describe('AuthLocalModule dependency injection', () => {
  it('resolves the controller and service with mocked leaf providers', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthLocalController],
      providers: [
        AuthLocalService,
        { provide: GoogleStrategy, useValue: {} },
        { provide: PrismaClient, useValue: {} },
        { provide: JwtService, useValue: {} },
      ],
    }).compile();

    expect(moduleRef.get(AuthLocalController)).toBeDefined();
    expect(moduleRef.get(AuthLocalService)).toBeDefined();
  });
});
