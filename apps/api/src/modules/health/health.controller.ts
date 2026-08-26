import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, LessThan, Not, Repository } from 'typeorm';
import { RedisService } from '../../common/redis/redis.service';
import { ConfigService } from '@nestjs/config';
import { StorageService } from '../../common/storage/storage.service';
import { AIProviderConfig } from '../ai/entities/ai-provider.entity';
import { ChannelConnectionState } from '../channel/channel-connection';
import { ChannelAccount } from '../channel/entities/channel-account.entity';
import { Public } from '../auth/session.guard';
import { Job, JobStatus } from '../jobs/entities/job.entity';

/** `PROJECT_SPEC.md` §130. */
export type ComponentStatus = 'HEALTHY' | 'WARNING' | 'CRITICAL';

interface ComponentHealth {
  status: ComponentStatus;
  detail?: string;
  latencyMs?: number;
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly dataSource: DataSource,
    private readonly redis: RedisService,
    @InjectRepository(Job) private readonly jobs: Repository<Job>,
    @InjectRepository(ChannelAccount) private readonly accounts: Repository<ChannelAccount>,
    @InjectRepository(AIProviderConfig) private readonly aiProviders: Repository<AIProviderConfig>,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Liveness. Public and deliberately trivial: it answers "is this process running", nothing more.
   * If it checked dependencies, a Redis blip would make an orchestrator kill a perfectly healthy
   * container.
   */
  @Public()
  @Get('live')
  @ApiOperation({ summary: 'Liveness probe — process is up' })
  live() {
    return { status: 'ok', uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000) };
  }

  /**
   * Readiness. Public so a container orchestrator can reach it, and deliberately terse: it exposes
   * only whether dependencies answer, never versions, hostnames, or error text that would help an
   * unauthenticated caller map the deployment.
   */
  @Public()
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe — dependencies reachable' })
  async ready() {
    const [database, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()]);
    const ready = database.status !== 'CRITICAL' && redis.status !== 'CRITICAL';
    return { status: ready ? 'ok' : 'unavailable', database: database.status, redis: redis.status };
  }

  /**
   * The detailed view for the dashboard (`PROJECT_SPEC.md` §130). Authenticated — unlike the probes
   * above — because it reports queue depth and failure counts.
   */
  @Get()
  @ApiOperation({ summary: 'Aggregated component health' })
  async detailed() {
    const [database, redis, queue, whatsapp, storage, ai, worker] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkQueue(),
      this.checkWhatsApp(),
      this.checkStorage(),
      this.checkAi(),
      this.checkWorker(),
    ]);

    const components = { database, redis, queue, whatsapp, storage, ai, worker };
    const statuses = Object.values(components).map((c) => c.status);
    const overall: ComponentStatus = statuses.includes('CRITICAL')
      ? 'CRITICAL'
      : statuses.includes('WARNING')
        ? 'WARNING'
        : 'HEALTHY';

    return {
      status: overall,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      components,
    };
  }

  /**
   * WhatsApp connectivity, measured from the accounts themselves.
   *
   * A disconnected account is a WARNING, not CRITICAL: an operator disconnects one deliberately all
   * the time, and paging somebody for a decision they made is how alerts get ignored. Every account
   * being down when accounts exist is the case worth shouting about.
   */
  private async checkWhatsApp(): Promise<ComponentHealth> {
    try {
      const total = await this.accounts.count();
      if (total === 0) return { status: 'HEALTHY', detail: 'no accounts configured' };

      const connected = await this.accounts.count({ where: { status: ChannelConnectionState.CONNECTED } });

      if (connected === 0) return { status: 'CRITICAL', detail: `0 of ${total} accounts connected` };
      if (connected < total) return { status: 'WARNING', detail: `${connected} of ${total} accounts connected` };
      return { status: 'HEALTHY', detail: `${connected} of ${total} accounts connected` };
    } catch (error) {
      return { status: 'CRITICAL', detail: (error as Error).message };
    }
  }

  /** Storage, checked by asking the driver rather than by trusting configuration. */
  private async checkStorage(): Promise<ComponentHealth> {
    try {
      const ready = await this.storage.healthy();
      return ready ? { status: 'HEALTHY' } : { status: 'CRITICAL', detail: 'storage is not writable' };
    } catch (error) {
      return { status: 'CRITICAL', detail: (error as Error).message };
    }
  }

  /**
   * The AI provider.
   *
   * Unconfigured is HEALTHY, not degraded: a deployment that answers only from deterministic rules
   * is a supported way to run this system, and colouring it red would train operators to ignore the
   * colour. A configured provider that is failing is the WARNING.
   */
  private async checkAi(): Promise<ComponentHealth> {
    try {
      // Read from the provider table and the environment directly rather than through the AI
      // gateway. Health must not depend on the module it reports on — an import edge from here
      // into the AI module put a cycle in the graph and stopped the application booting at all,
      // which is a spectacular way for a health check to fail.
      const active = await this.aiProviders.count({ where: { isActive: true } });
      const envConfigured = (this.config.get<string>('ai.provider') ?? 'none') !== 'none';

      if (active === 0 && !envConfigured) return { status: 'HEALTHY', detail: 'no provider configured' };

      if (active > 0) {
        const failing = await this.aiProviders.count({
          where: { isActive: true, lastError: Not(IsNull()) },
        });
        if (failing === active) {
          return { status: 'WARNING', detail: `all ${active} provider(s) reported a recent failure` };
        }
        return { status: 'HEALTHY', detail: `${active - failing} of ${active} provider(s) healthy` };
      }

      return { status: 'HEALTHY', detail: 'configured from the environment' };
    } catch (error) {
      return { status: 'WARNING', detail: (error as Error).message };
    }
  }

  /**
   * Whether a worker is actually consuming.
   *
   * Inferred from the jobs table rather than from a heartbeat key, for the same reason queue depth
   * is: Redis can be flushed, and the durable rows cannot. A job that has been RUNNING for longer
   * than any real job takes means a worker died holding it.
   */
  private async checkWorker(): Promise<ComponentHealth> {
    try {
      const stuckSince = new Date(Date.now() - 30 * 60 * 1000);
      const stuck = await this.jobs.count({
        where: { status: JobStatus.RUNNING, startedAt: LessThan(stuckSince) },
      });

      if (stuck > 0) {
        return { status: 'WARNING', detail: `${stuck} job(s) running for over 30 minutes` };
      }
      return { status: 'HEALTHY' };
    } catch (error) {
      return { status: 'CRITICAL', detail: (error as Error).message };
    }
  }

  private async checkDatabase(): Promise<ComponentHealth> {
    const start = Date.now();
    try {
      await this.dataSource.query('SELECT 1');
      const latencyMs = Date.now() - start;
      return { status: latencyMs > 1000 ? 'WARNING' : 'HEALTHY', latencyMs };
    } catch (error) {
      return { status: 'CRITICAL', detail: (error as Error).message };
    }
  }

  private async checkRedis(): Promise<ComponentHealth> {
    const start = Date.now();
    const ok = await this.redis.ping();
    const latencyMs = Date.now() - start;
    if (!ok) return { status: 'CRITICAL', detail: 'PING failed' };
    return { status: latencyMs > 500 ? 'WARNING' : 'HEALTHY', latencyMs };
  }

  /**
   * Queue health is measured from the durable Postgres rows, not from Redis. A queue that looks
   * empty because Redis was flushed is not healthy, and the job table is the source of truth (§184).
   */
  private async checkQueue(): Promise<ComponentHealth> {
    try {
      const [queued, running, failed] = await Promise.all([
        this.jobs.count({ where: { status: JobStatus.QUEUED } }),
        this.jobs.count({ where: { status: JobStatus.RUNNING } }),
        this.jobs.count({ where: { status: JobStatus.FAILED } }),
      ]);

      // A deep backlog is a warning, never critical: it usually means the system is busy, and
      // paging someone for a busy queue trains them to ignore the alert.
      const status: ComponentStatus = queued > 100 ? 'WARNING' : 'HEALTHY';
      return { status, detail: `queued=${queued} running=${running} failed=${failed}` };
    } catch (error) {
      return { status: 'CRITICAL', detail: (error as Error).message };
    }
  }
}
