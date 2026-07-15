import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadRuntimeEnv } from '../../api/src/common/runtime-env.js';
import { WorkerModule } from './worker.module.js';

async function bootstrap(): Promise<void> {
  loadRuntimeEnv(process.env);
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.enableShutdownHooks();
}

void bootstrap();
