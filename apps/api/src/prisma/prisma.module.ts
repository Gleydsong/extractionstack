import { Module, Global, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

@Global()
@Module({
  providers: [
    PrismaService,
    { provide: PrismaClient, useExisting: PrismaService },
  ],
  exports: [PrismaClient],
})
export class PrismaModule {}
