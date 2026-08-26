import { BullModule } from '@nestjs/bullmq';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import cookieParser from 'cookie-parser';
import { join } from 'node:path';
import { CryptoModule } from './common/crypto/crypto.module';
import { MetricsModule } from './common/metrics/metrics.module';
import { RedisModule } from './common/redis/redis.module';
import { configuration } from './config/configuration';
import { validateEnv } from './config/env.validation';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { SessionGuard } from './modules/auth/session.guard';
import { ChannelModule } from './modules/channel/channel.module';
import { CrmModule } from './modules/crm/crm.module';
import { GroupsModule } from './modules/groups/groups.module';
import { HealthModule } from './modules/health/health.module';
import { IngestionModule } from './modules/ingestion/ingestion.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { AiModule } from './modules/ai/ai.module';
import { CopilotModule } from './modules/copilot/copilot.module';
import { ReportsModule } from './modules/reports/reports.module';
import { AutomationModule } from './modules/automation/automation.module';
import { BroadcastModule } from './modules/broadcast/broadcast.module';
import { BulkModule } from './modules/bulk/bulk.module';
import { DecisionModule } from './modules/decision/decision.module';
import { EscalationModule } from './modules/escalation/escalation.module';
import { KnowledgeModule } from './modules/knowledge/knowledge.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import { TeamModule } from './modules/team/team.module';
import { RbacModule } from './modules/rbac/rbac.module';
import { PermissionsGuard } from './modules/rbac/permissions.guard';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { SettingsModule } from './modules/settings/settings.module';

/**
 * The modular monolith (`PROJECT_SPEC.md` §120).
 *
 * One module graph, two run modes: `RUN_MODE=api` serves HTTP and WebSocket; `RUN_MODE=worker`
 * consumes queues. Same code, same entities, same migrations — which is what keeps the two from
 * drifting, and what makes "scale the workers" a deployment decision rather than a code change.
 */
@Module({
  imports: [
    // `envFilePath` is resolved from this file, not from the working directory. In a container the
    // environment is injected and no file is read at all; running the API or the worker from a
    // developer's machine starts in `apps/api`, where there is no .env, and the process would fail
    // validation for variables that are sitting in the repository root the whole time.
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [join(__dirname, '..', '.env'), join(__dirname, '..', '..', '..', '.env')],
      load: [configuration],
      validate: validateEnv,
      cache: true,
    }),

    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        host: config.getOrThrow<string>('database.host'),
        port: config.getOrThrow<number>('database.port'),
        username: config.getOrThrow<string>('database.username'),
        password: config.getOrThrow<string>('database.password'),
        database: config.getOrThrow<string>('database.name'),
        ssl: config.get<boolean>('database.ssl') ? { rejectUnauthorized: false } : false,
        // One definition of a day across Node and SQL. Without this Postgres runs Etc/UTC while the
        // application runs its configured TZ, and "today" means two different things depending on
        // which layer computed it. See the same option in `database/data-source.ts`.
        extra: { options: `-c timezone=${config.get<string>('timezone') ?? 'UTC'}` },
        logging: config.get<boolean>('database.logging', false),
        entities: [join(__dirname, 'modules', '**', '*.entity.{ts,js}')],
        // Registered so `dataSource.runMigrations()` can be driven programmatically (the migrate
        // entrypoint and the integration harness both do). Without this the DataSource knows of no
        // migrations and runMigrations() silently succeeds having applied nothing.
        migrations: [join(__dirname, 'database', 'migrations', '*.{ts,js}')],
        // Never true. Schema changes go through reviewed migrations only (PROJECT_SPEC.md §152, §204).
        synchronize: false,
        // Migrations are applied by an explicit `pnpm db:migrate` step (a one-shot compose service
        // in Docker), not on boot — several API replicas racing to migrate the same database is a
        // deadlock waiting to happen.
        migrationsRun: false,
      }),
    }),

    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.getOrThrow<string>('redis.host'),
          port: config.getOrThrow<number>('redis.port'),
          password: config.get<string>('redis.password'),
          db: config.getOrThrow<number>('redis.db'),
          // BullMQ's blocking reads abort if a per-request retry cap is in force.
          maxRetriesPerRequest: null,
        },
        prefix: `${config.getOrThrow<string>('redis.keyPrefix')}:bull`,
      }),
    }),

    CryptoModule,
    RedisModule,
    MetricsModule,
    AuditModule,
    SettingsModule,
    AuthModule,
    RbacModule,
    RealtimeModule,
    JobsModule,
    KnowledgeModule,
    AiModule,
    ReportsModule,
    CopilotModule,
    AutomationModule,
    DecisionModule,
    EscalationModule,
    BulkModule,
    BroadcastModule,
    // Phase 2 — the WhatsApp channel. ChannelModule and IngestionModule/MessagingModule reference
    // each other through forwardRef(): ingestion needs the adapter to verify a signature, and the
    // channel controller needs ingestion to build the webhook callback URL it registers.
    TeamModule,
    GroupsModule,
    // Phase 3 — the customer and conversation domain the decision engine will consume.
    CrmModule,
    ChannelModule,
    IngestionModule,
    MessagingModule,
    HealthModule,
  ],
  providers: [
    // Order matters and is guaranteed: SessionGuard authenticates and attaches the user, then
    // PermissionsGuard authorises. Registering them globally means a new controller is protected by
    // default and must opt out with @Public() — the safe direction (PROJECT_SPEC.md §201).
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(cookieParser()).forRoutes('*');
  }
}
