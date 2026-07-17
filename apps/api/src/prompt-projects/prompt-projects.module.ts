import { Module } from '@nestjs/common';
import { Queue } from 'bullmq';
import { AiConnectionsModule } from '../ai-connections/ai-connections.module.js';
import { loadRuntimeEnv } from '../common/runtime-env.js';
import { CreditsModule } from '../credits/credits.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import {
  BullMqPromptGenerationQueue,
  LLM_BULL_QUEUE,
  LLM_QUEUE_NAME,
  type LlmQueuePayload,
} from './prompt-generation.queue.js';
import {
  PromptJobsController,
  PromptProjectsController,
  PromptVersionsController,
} from './prompt-projects.controller.js';
import { PromptProjectsRepository } from './prompt-projects.repository.js';
import { LlmReconciliationController } from './llm-reconciliation.controller.js';
import { LlmReconciliationService } from './llm-reconciliation.service.js';
import {
  PROMPT_GENERATION_QUEUE,
  PROMPT_PROJECTS_REPOSITORY,
  PromptProjectsService,
} from './prompt-projects.service.js';

@Module({
  imports: [PrismaModule, AiConnectionsModule, CreditsModule],
  controllers: [
    PromptProjectsController,
    PromptVersionsController,
    PromptJobsController,
    LlmReconciliationController,
  ],
  providers: [
    PromptProjectsRepository,
    PromptProjectsService,
    LlmReconciliationService,
    BullMqPromptGenerationQueue,
    {
      provide: LLM_BULL_QUEUE,
      useFactory: (): Queue<LlmQueuePayload> => {
        const redis = new URL(loadRuntimeEnv(process.env).REDIS_URL);
        return new Queue<LlmQueuePayload>(LLM_QUEUE_NAME, {
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
    { provide: PROMPT_PROJECTS_REPOSITORY, useExisting: PromptProjectsRepository },
    { provide: PROMPT_GENERATION_QUEUE, useExisting: BullMqPromptGenerationQueue },
  ],
})
export class PromptProjectsModule {}
