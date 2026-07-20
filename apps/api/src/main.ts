import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import helmet from 'helmet';
import { json } from 'express';
import { AppModule } from './app.module.js';
import { HttpExceptionFilter } from './common/http-exception.filter.js';
import { loadRuntimeEnv } from './common/runtime-env.js';
import { createRequestLogger, requestIdMiddleware } from './common/request-context.js';

async function bootstrap(): Promise<void> {
  const env = loadRuntimeEnv(process.env);
  const app = await NestFactory.create(AppModule, { bufferLogs: true, bodyParser: false });
  app.enableShutdownHooks();
  if (env.API_TRUST_PROXY !== 'false') {
    const trustProxy = /^\d+$/.test(env.API_TRUST_PROXY)
      ? Number(env.API_TRUST_PROXY)
      : env.API_TRUST_PROXY;
    app.getHttpAdapter().getInstance().set('trust proxy', trustProxy);
  }

  app.use(requestIdMiddleware);
  app.use(createRequestLogger());
  app.use(json({ limit: '16kb', strict: true }));
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );
  app.enableCors({
    origin: env.CORS_ORIGIN.split(',').map((origin) => origin.trim()),
    credentials: true,
  });

  app.useGlobalFilters(new HttpExceptionFilter());

  await app.listen(env.API_PORT);
  Logger.log(`API listening on :${env.API_PORT}`, 'Bootstrap');
}

void bootstrap();
