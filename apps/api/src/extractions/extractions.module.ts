import { Module } from '@nestjs/common';
import { Queue } from 'bullmq';
import { loadRuntimeEnv } from '../common/runtime-env.js';
import {
  BullMqExtractionQueue,
  EXTRACTION_BULL_QUEUE,
  EXTRACTION_QUEUE_NAME,
  type ExtractionQueuePayload,
} from './extraction-queue.js';
import { ExtractionsController } from './extractions.controller.js';
import { ExtractionsRepository } from './extractions.repository.js';
import { ExtractionsService } from './extractions.service.js';
import { EXTRACTION_QUEUE, EXTRACTIONS_REPOSITORY } from './extractions.types.js';

@Module({
  controllers: [ExtractionsController],
  providers: [
    ExtractionsRepository,
    ExtractionsService,
    BullMqExtractionQueue,
    {
      provide: EXTRACTION_BULL_QUEUE,
      useFactory: (): Queue<ExtractionQueuePayload> => {
        const redis = new URL(loadRuntimeEnv(process.env).REDIS_URL);
        return new Queue<ExtractionQueuePayload>(EXTRACTION_QUEUE_NAME, {
          connection: {
            host: redis.hostname,
            port: Number(redis.port || 6379),
            username: redis.username || undefined,
            password: redis.password || undefined,
            db: redis.pathname.length > 1 ? Number(redis.pathname.slice(1)) : 0,
            ...(redis.protocol === 'rediss:' ? { tls: {} } : {}),
          },
        });
      },
    },
    { provide: EXTRACTIONS_REPOSITORY, useExisting: ExtractionsRepository },
    { provide: EXTRACTION_QUEUE, useExisting: BullMqExtractionQueue },
  ],
})
export class ExtractionsModule {}
