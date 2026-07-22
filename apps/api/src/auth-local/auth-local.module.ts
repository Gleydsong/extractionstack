import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { AuthLocalService } from './auth-local.service.js';
import { AuthLocalController } from './auth-local.controller.js';
import { GoogleStrategy } from './google.strategy.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { loadRuntimeEnv } from '../common/runtime-env.js';

@Module({
  imports: [
    PrismaModule,
    PassportModule.register({ defaultStrategy: 'jwt', session: false }),
    JwtModule.registerAsync({
      useFactory: () => {
        const env = loadRuntimeEnv(process.env);
        return {
          secret: env.LOCAL_JWT_SECRET,
          signOptions: { expiresIn: env.LOCAL_JWT_TTL_SECONDS },
        };
      },
    }),
  ],
  controllers: [AuthLocalController],
  providers: [AuthLocalService, GoogleStrategy],
  exports: [AuthLocalService],
})
export class AuthLocalModule {}
