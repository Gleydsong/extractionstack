import { Module } from '@nestjs/common';
import { ExtractModule } from '../../api/src/extract/extract.module.js';
import { ExtractService } from '../../api/src/extract/extract.service.js';
import { PrismaModule } from '../../api/src/prisma/prisma.module.js';
import { QueueWorkerService } from './queue-worker.service.js';
import { WorkerJobRepository } from './worker-job.repository.js';
import { WorkerProcessor } from './worker.processor.js';
import { WORKER_EXTRACTOR, WORKER_JOB_STORE } from './worker.types.js';

@Module({
  imports: [PrismaModule, ExtractModule],
  providers: [
    WorkerJobRepository,
    WorkerProcessor,
    QueueWorkerService,
    { provide: WORKER_JOB_STORE, useExisting: WorkerJobRepository },
    { provide: WORKER_EXTRACTOR, useExisting: ExtractService },
  ],
})
export class WorkerModule {}
