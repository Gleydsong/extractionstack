import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadRuntimeEnv } from '../../api/src/common/runtime-env.js';
import { LlmWorkerModule } from './llm-worker.module.js';

async function bootstrap(): Promise<void> {
  loadRuntimeEnv(process.env);
  const app = await NestFactory.createApplicationContext(LlmWorkerModule);
  app.enableShutdownHooks();
}

void bootstrap();
