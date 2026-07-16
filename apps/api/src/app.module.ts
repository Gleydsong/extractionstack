import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ExtractionsModule } from './extractions/extractions.module.js';
import { OperationsModule } from './operations/operations.module.js';
import { AiConnectionsModule } from './ai-connections/ai-connections.module.js';
import { CreditsModule } from './credits/credits.module.js';

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
    ExtractionsModule,
    OperationsModule,
    AiConnectionsModule,
    CreditsModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
