import './run-mode-worker'; // must be first: modules read RUN_MODE as they are imported
import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppLogger } from './common/logging/app-logger';
import { RedisService } from './common/redis/redis.service';
import { RedisIoAdapter } from './modules/realtime/redis-io.adapter';
import { JobsService } from './modules/jobs/jobs.service';

/**
 * Worker process bootstrap.
 *
 * Same module graph as the API, different responsibilities: it consumes queues and serves exactly
 * one HTTP route — a liveness endpoint bound to loopback for its own container healthcheck. It
 * publishes no port. `docs/ARCHITECTURE_AUDIT.md` §6.1.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);
  const logger = new AppLogger('worker');
  app.useLogger(logger);

  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();

  // The worker accepts no browser connections; it installs the adapter so the events its processors
  // emit — inbound messages, connection states, pairing codes — reach the API replicas that do.
  const realtimeAdapter = new RedisIoAdapter(app, app.get(RedisService));
  await realtimeAdapter.connect();
  app.useWebSocketAdapter(realtimeAdapter);

  // Crash recovery before consuming anything: jobs a previous worker left RUNNING would otherwise
  // sit there forever, since BullMQ considers their delivery complete.
  const recovered = await app.get(JobsService).recoverStuckJobs();
  if (recovered > 0) logger.warn('Requeued jobs from a previous worker', { count: recovered });

  const port = config.getOrThrow<number>('worker.healthPort');
  await app.listen(port, '127.0.0.1');

  logger.log('Support CRM worker started', {
    healthPort: port,
    concurrency: config.getOrThrow<number>('worker.concurrency'),
  });
}

void bootstrap();
