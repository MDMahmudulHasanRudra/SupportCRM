import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { Job as BullJob } from 'bullmq';
import { Repository } from 'typeorm';
import { AppLogger } from '../../common/logging/app-logger';
import { LockService } from '../../common/redis/lock.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { Job, JobStatus } from './entities/job.entity';
import { JobItem, JobItemStatus } from './entities/job-item.entity';
import { QUEUES } from './queues';

/**
 * A handler for one job type. Registered by the module that owns that type — the Job Center itself
 * knows nothing about groups, broadcasts or knowledge indexing.
 */
export interface JobItemHandler {
  /** Processes one item. Throwing marks that item FAILED; other items continue. */
  handle(item: JobItem, job: Job): Promise<Record<string, unknown> | void>;
}

/** How long a job holds its lock before another worker may adopt it. Extended between items. */
const JOB_LOCK_TTL_MS = 60_000;

/**
 * The single consumer of the Job Center queue.
 *
 * Responsibilities, deliberately narrow: claim the job under a distributed lock, walk its PENDING
 * items, call the registered handler for each, record per-item outcome, publish progress, and
 * finalise. It never decides what an item *means*.
 *
 * Two safety properties:
 *  - **A lock per job.** With several workers running, two must never process one job's items
 *    concurrently (`PROJECT_SPEC.md` §185).
 *  - **One item's failure is not the job's failure.** `PROJECT_SPEC.md` §50/§122 require per-item
 *    errors and a partial-success outcome, so a handler throwing is caught, recorded on the item,
 *    and the walk continues.
 */
@Injectable()
@Processor(QUEUES.JOB_CENTER)
export class JobProcessor extends WorkerHost {
  private readonly logger = new AppLogger(JobProcessor.name);
  private readonly handlers = new Map<string, JobItemHandler>();

  constructor(
    @InjectRepository(Job) private readonly jobs: Repository<Job>,
    @InjectRepository(JobItem) private readonly items: Repository<JobItem>,
    private readonly locks: LockService,
    private readonly realtime: RealtimeGateway,
    private readonly config: ConfigService,
  ) {
    super();
    this.registerHandler(JobTypeEcho, new EchoHandler());
  }

  registerHandler(type: string, handler: JobItemHandler): void {
    this.handlers.set(type, handler);
  }

  async process(bullJob: BullJob<{ jobId: string }>): Promise<void> {
    const { jobId } = bullJob.data;

    const outcome = await this.locks.withLock(`job:${jobId}`, JOB_LOCK_TTL_MS, () =>
      this.runJob(jobId),
    );

    if (outcome === null) {
      // Another worker holds it. Not an error — BullMQ's own retry will not help and must not fire.
      this.logger.debug('Job already being processed by another worker', { jobId });
    }
  }

  private async runJob(jobId: string): Promise<void> {
    const job = await this.jobs.findOne({ where: { id: jobId } });
    if (!job) {
      this.logger.warn('Job row missing for queued job — nothing to do', { jobId });
      return;
    }
    if (job.status === JobStatus.CANCELLED || job.status === JobStatus.COMPLETED) return;

    const handler = this.handlers.get(job.type);
    if (!handler) {
      // Fail loudly rather than silently completing an empty job — an unregistered type is a wiring
      // bug, and a job that reports success without doing anything is the worst possible outcome.
      await this.finalise(job, JobStatus.FAILED, `No handler registered for job type "${job.type}"`);
      return;
    }

    await this.jobs.update(job.id, { status: JobStatus.RUNNING, startedAt: job.startedAt ?? new Date() });
    this.publishProgress(job.id);

    const batchSize = this.config.get<number>('worker.concurrency', 5);
    let cancelled = false;

    for (;;) {
      // Re-read the cancel flag every batch, so a cancel issued mid-run takes effect promptly
      // without needing to interrupt an in-flight item.
      const current = await this.jobs.findOne({ where: { id: job.id } });
      if (!current) return;
      if (current.cancelRequested) {
        cancelled = true;
        break;
      }

      const batch = await this.items.find({
        where: { jobId: job.id, status: JobItemStatus.PENDING },
        order: { createdAt: 'ASC' },
        take: batchSize,
      });
      if (batch.length === 0) break;

      for (const item of batch) {
        await this.processItem(item, current, handler);
      }

      this.publishProgress(job.id);
    }

    if (cancelled) {
      await this.items.update(
        { jobId: job.id, status: JobItemStatus.PENDING },
        { status: JobItemStatus.CANCELLED },
      );
      await this.finalise(job, JobStatus.CANCELLED);
      return;
    }

    const failed = await this.items.count({ where: { jobId: job.id, status: JobItemStatus.FAILED } });
    await this.finalise(job, failed > 0 ? JobStatus.COMPLETED_WITH_ERRORS : JobStatus.COMPLETED);
  }

  private async processItem(item: JobItem, job: Job, handler: JobItemHandler): Promise<void> {
    await this.items.update(item.id, {
      status: JobItemStatus.PROCESSING,
      attempts: item.attempts + 1,
    });

    try {
      const result = await handler.handle(item, job);
      await this.items.update(item.id, {
        status: JobItemStatus.COMPLETED,
        // TypeORM's update() types a jsonb column as a deep-partial; an arbitrary handler result
        // is structurally wider, so it is cast at this one boundary rather than weakening the type.
        result: ((result as Record<string, unknown>) ?? null) as never,
        error: null,
        processedAt: new Date(),
      });
      await this.jobs.increment({ id: job.id }, 'completedItems', 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.items.update(item.id, {
        status: JobItemStatus.FAILED,
        error: message.slice(0, 2000),
        processedAt: new Date(),
      });
      await this.jobs.increment({ id: job.id }, 'failedItems', 1);
      this.logger.warn('Job item failed', { jobId: job.id, reference: item.reference, error: message });
    }
  }

  private async finalise(job: Job, status: JobStatus, error?: string): Promise<void> {
    await this.jobs.update(job.id, { status, error: error ?? null, finishedAt: new Date() });
    this.publishProgress(job.id);
    this.logger.log('Job finished', { jobId: job.id, status });
  }

  /** Best-effort: a realtime publish failure must never fail the job. */
  private publishProgress(jobId: string): void {
    void this.jobs
      .findOne({ where: { id: jobId } })
      .then((job) => {
        if (!job) return;
        this.realtime.emitJobProgress({
          jobId: job.id,
          status: job.status,
          totalItems: job.totalItems,
          completedItems: job.completedItems,
          failedItems: job.failedItems,
          progressPercent: job.progressPercent,
        });
      })
      .catch(() => undefined);
  }
}

/**
 * `SYSTEM_ECHO` — a real, permanently useful job type, not a placeholder.
 *
 * It exercises the entire pipeline end to end (create → enqueue → lock → per-item processing →
 * progress → completion, including the failure path) without depending on WhatsApp, AI, or any
 * Phase 2+ feature. It is what the Phase 1 acceptance test drives, and it stays as a production
 * smoke test for the queue.
 *
 * An item whose reference starts with `fail:` throws — the only way to prove that one item failing
 * does not take the job down with it.
 */
const JobTypeEcho = 'SYSTEM_ECHO';

export class EchoHandler implements JobItemHandler {
  async handle(item: JobItem): Promise<Record<string, unknown>> {
    if (item.reference.startsWith('fail:')) {
      throw new Error(`Simulated failure for "${item.reference}"`);
    }
    return { echoed: item.reference, at: new Date().toISOString() };
  }
}
