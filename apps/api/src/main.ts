import './run-mode-api'; // must be first: modules read RUN_MODE as they are imported
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { applyBodyParsers } from './common/http/body-parsers';
import { AppLogger } from './common/logging/app-logger';
import { RedisService } from './common/redis/redis.service';
import { RedisIoAdapter } from './modules/realtime/redis-io.adapter';


/**
 * API process bootstrap.
 *
 * `PROJECT_SPEC.md` §116 (versioned REST + OpenAPI), §109 and §201 (secure headers, no
 * unrestricted CORS, validation everywhere, no debug surface in production).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);
  const logger = new AppLogger('bootstrap');
  app.useLogger(logger);

  app.setGlobalPrefix('api/v1');

  // Realtime events are produced by the worker, and the operator's socket lives here. Without this
  // adapter the two never meet and the UI silently stops updating.
  const realtimeAdapter = new RedisIoAdapter(app, app.get(RedisService));
  await realtimeAdapter.connect();
  app.useWebSocketAdapter(realtimeAdapter);

  app.use(helmet({ contentSecurityPolicy: false })); // CSP belongs to the UI app, not the JSON API.

  // Body parsers, including raw-body capture for webhook signature verification. Shared with the
  // integration harness so the two environments cannot drift (see body-parsers.ts).
  applyBodyParsers(app);

  const origins = config.getOrThrow<string[]>('http.corsOrigins');
  app.enableCors({
    // Exact origins only. `credentials: true` with a wildcard is rejected by browsers anyway, and
    // the session cookie makes credentials mandatory (PROJECT_SPEC.md §201).
    origin: origins,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      // Strips unknown fields, and `forbidNonWhitelisted` turns a stray property into a 400 rather
      // than silently ignoring it — a typo'd field name should be visible, not swallowed.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // Required for `request.ip` to reflect the real client behind a reverse proxy — the audit trail
  // records that value, and a wrong one is worse than none. Set on the Express instance directly;
  // INestApplication does not expose it.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  if (config.getOrThrow<boolean>('http.enableSwagger')) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Support CRM API')
        .setDescription('WhatsApp-first Support CRM. See PROJECT_SPEC.md for the canonical spec.')
        .setVersion('0.1.0')
        .addCookieAuth(config.getOrThrow<string>('security.sessionCookieName'))
        .build(),
    );
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = config.getOrThrow<number>('http.port');
  await app.listen(port, '0.0.0.0');

  logger.log('Support CRM API started', {
    port,
    env: config.getOrThrow<string>('env'),
    swagger: config.getOrThrow<boolean>('http.enableSwagger'),
  });
}

void bootstrap();
