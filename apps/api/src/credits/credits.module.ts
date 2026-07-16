import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { CREDITS_REPOSITORY, CreditsRepository } from './credits.repository.js';
import { CreditsService } from './credits.service.js';

@Module({
  imports: [PrismaModule],
  providers: [
    CreditsRepository,
    { provide: CREDITS_REPOSITORY, useExisting: CreditsRepository },
    CreditsService,
  ],
  exports: [CreditsService],
})
export class CreditsModule {}
