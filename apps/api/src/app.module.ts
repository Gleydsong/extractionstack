import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module.js';
import { ExtractModule } from './extract/extract.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ExtractionsModule } from './extractions/extractions.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([
      {
        ttl: Number(process.env.THROTTLE_TTL_SECONDS ?? 60) * 1000,
        limit: Number(process.env.THROTTLE_LIMIT ?? 10),
      },
    ]),
    PrismaModule,
    AuthModule,
    ExtractModule,
    ExtractionsModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
