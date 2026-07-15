import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { HttpExceptionFilter } from './common/http-exception.filter.js';
import { loadRuntimeEnv } from './common/runtime-env.js';

async function bootstrap(): Promise<void> {
  const env = loadRuntimeEnv(process.env);
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.enableShutdownHooks();

  app.use(helmet());
  app.enableCors({
    origin: env.CORS_ORIGIN.split(',').map((origin) => origin.trim()),
    credentials: true,
  });

  app.useGlobalFilters(new HttpExceptionFilter());

  await app.listen(env.API_PORT);
  Logger.log(`API listening on :${env.API_PORT}`, 'Bootstrap');
}

void bootstrap();
