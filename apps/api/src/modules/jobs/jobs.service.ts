import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, In, Repository } from 'typeorm';
import { AppLogger } from '../../common/logging/app-logger';
import { Job, JobStatus, JobType } from './entities/job.entity';
import { JobItem, JobItemStatus } from './entities/job-item.entity';
import { DEFAULT_JOB_OPTIONS, QUEUES } from './queues';

export interface CreateJobInput {
  type: JobType;
  name: string;
  payload?: Record<string, unknown>;
  /** One entry per unit of work. An empty list is rejected — a job with nothing to do is a bug. */
  items: Array<{ reference: string; payload?: Record<string, unknown> }>;
  idempotencyKey?: string;
  createdById?: string | null;
}

/**
 * The Job Center (`PROJECT_SPEC.md` §49–51).
 *
 * Bulk work is never done inside an HTTP request. A caller creates a job with its item list, gets a
 * job id back immediately, and watches progress. `PROJECT_SPEC.md` §49 states this as a hard rule
 * and it is the reason this module exists in Phase 1 rather than Phase 8 — building bulk features
 * first and retrofitting async is how bulk features end up blocking the request thread.
 */
@Injectable()
export class JobsService {
  private readonly logger = new AppLogger(JobsService.name);

  constructor(
    @InjectRepository(Job) private readonly jobs: Repository<Job>,
    @InjectRepository(JobItem) private readonly items: Repository<JobItem>,
    @InjectQueue(QUEUES.JOB_CENTER) private readonly queue: Queue,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Creates a job and its items in one transaction, then enqueues it.
   *
   * The transaction matters: a job row without its items would report `totalItems: 0` and complete
   * instantly, silently doing nothing. Enqueue happens AFTER the commit — enqueuing inside would let
   * a worker pick the job up and find no items, since it reads through a different connection.
   */
  async create(input: CreateJobInput): Promise<Job> {
    if (input.items.length === 0) {
      throw new BadRequestException('A job must have at least one item');
    }

    if (input.idempotencyKey) {
      const existing = await this.jobs.findOne({ where: { idempotencyKey: input.idempotencyKey } });
      // Returning the original rather than erroring is what makes a retried request safe: the
      // caller gets the same job id and can carry on watching it (PROJECT_SPEC.md §117).
      if (existing) return existing;
    }

    let job: Job;
    try {
      job = await this.createWithItems(input);
    } catch (error) {
      // Two callers raced the idempotency check above and the unique index arbitrated. Return
      // the winner rather than surfacing a constraint violation — `MessageService.send` has
      // handled this since Phase 2, and job creation must behave the same way or "idempotent"
      // only holds when nothing is concurrent.
      if ((error as { code?: string }).code === '23505' && input.idempotencyKey) {
        const winner = await this.jobs.findOne({ where: { idempotencyKey: input.idempotencyKey } });
        if (winner) return winner;
      }
      throw error;
    }

    await this.queue.add(job.type, { jobId: job.id }, { ...DEFAULT_JOB_OPTIONS, jobId: job.id });

    this.logger.log('Job enqueued', { jobId: job.id, type: job.type, totalItems: job.totalItems });
    return job;
  }

  /** The transactional create, split out so `create()` can wrap it in the race handler. */
  private async createWithItems(input: CreateJobInput): Promise<Job> {
    return this.dataSource.transaction(async (manager) => {
      const created = await manager.save(
        manager.create(Job, {
          type: input.type,
          name: input.name,
          payload: input.payload ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          totalItems: input.items.length,
          createdById: input.createdById ?? null,
          status: JobStatus.QUEUED,
        }),
      );

      // chunked: a 3,000-group bulk action would otherwise build one enormous INSERT.
      const CHUNK = 500;
      for (let i = 0; i < input.items.length; i += CHUNK) {
        await manager.save(
          input.items.slice(i, i + CHUNK).map((item) =>
            manager.create(JobItem, {
              jobId: created.id,
              reference: item.reference,
              payload: item.payload ?? null,
              status: JobItemStatus.PENDING,
            }),
          ),
        );
      }

      return created;
    });
  }

  async findOne(id: string): Promise<Job> {
    const job = await this.jobs.findOne({ where: { id } });
    if (!job) throw new NotFoundException(`Job ${id} not found`);
    return job;
  }

  async list(options: { status?: JobStatus; type?: JobType; limit?: number; offset?: number } = {}) {
    const limit = Math.min(options.limit ?? 25, 100);
    const offset = Math.max(options.offset ?? 0, 0);

    const qb = this.jobs.createQueryBuilder('job').orderBy('job.createdAt', 'DESC');
    if (options.status) qb.andWhere('job.status = :status', { status: options.status });
    if (options.type) qb.andWhere('job.type = :type', { type: options.type });

    const [items, total] = await qb.skip(offset).take(limit).getManyAndCount();
    return { items, total, limit, offset };
  }

  /** Paginated because a bulk job over 3,000 groups has 3,000 items (`PROJECT_SPEC.md` §103). */
  async listItems(
    jobId: string,
    options: { status?: JobItemStatus; limit?: number; offset?: number } = {},
  ) {
    await this.findOne(jobId);
    const limit = Math.min(options.limit ?? 50, 500);
    const offset = Math.max(options.offset ?? 0, 0);

    const [items, total] = await this.items.findAndCount({
      where: { jobId, ...(options.status ? { status: options.status } : {}) },
      order: { createdAt: 'ASC' },
      skip: offset,
      take: limit,
    });
    return { items, total, limit, offset };
  }

  /**
   * Co-operative cancellation (`PROJECT_SPEC.md` §50).
   *
   * Sets a flag the processor checks between items rather than killing the worker: an item that is
   * mid-send must be allowed to finish, or the system would lose track of whether it went out.
   */
  async requestCancel(id: string): Promise<Job> {
    const job = await this.findOne(id);
    if (job.status === JobStatus.COMPLETED || job.status === JobStatus.CANCELLED) {
      throw new BadRequestException(`Job is already ${job.status.toLowerCase()}`);
    }

    await this.jobs.update(id, { cancelRequested: true });

    if (job.status === JobStatus.QUEUED) {
      // Not started yet — remove it from Redis and finalise immediately, so a queued job cancels
      // instantly instead of waiting for a worker to pick it up just to abandon it.
      await this.queue.remove(id).catch(() => undefined);
      await this.jobs.update(id, { status: JobStatus.CANCELLED, finishedAt: new Date() });
      await this.items.update(
        { jobId: id, status: JobItemStatus.PENDING },
        { status: JobItemStatus.CANCELLED },
      );
    }

    return this.findOne(id);
  }

  /**
   * Re-queues only the failed items (`PROJECT_SPEC.md` §50, §58).
   *
   * Deliberately never re-runs the successes: re-applying 482 completed group updates to retry 18
   * failures is exactly the behaviour a retry button must not have.
   */
  async retryFailed(id: string): Promise<Job> {
    const job = await this.findOne(id);

    const failed = await this.items.count({ where: { jobId: id, status: JobItemStatus.FAILED } });
    if (failed === 0) throw new BadRequestException('This job has no failed items to retry');

    await this.items.update(
      { jobId: id, status: JobItemStatus.FAILED },
      { status: JobItemStatus.PENDING, error: null },
    );
    await this.jobs.update(id, {
      status: JobStatus.QUEUED,
      failedItems: 0,
      cancelRequested: false,
      error: null,
      finishedAt: null,
    });

    // A distinct BullMQ job id: the original completed and BullMQ would reject a duplicate id.
    // Hyphen-separated, not colon-separated: BullMQ only tolerates ':' in a custom id when it
    // splits into exactly three parts, and its own source marks that allowance for removal.
    await this.queue.add(
      job.type,
      { jobId: id },
      { ...DEFAULT_JOB_OPTIONS, jobId: `${id}-retry-${Date.now()}` },
    );

    this.logger.log('Retrying failed job items', { jobId: id, failedItems: failed });
    return this.findOne(id);
  }

  /** Requeues jobs a crashed worker left mid-flight. Called on worker boot. */
  async recoverStuckJobs(): Promise<number> {
    const stuck = await this.jobs.find({ where: { status: JobStatus.RUNNING } });
    if (stuck.length === 0) return 0;

    await this.items.update(
      { jobId: In(stuck.map((j) => j.id)), status: JobItemStatus.PROCESSING },
      { status: JobItemStatus.PENDING },
    );
    await this.jobs.update(
      { id: In(stuck.map((j) => j.id)) },
      { status: JobStatus.QUEUED, startedAt: null },
    );

    for (const job of stuck) {
      await this.queue.add(
        job.type,
        { jobId: job.id },
        { ...DEFAULT_JOB_OPTIONS, jobId: `${job.id}-recover-${Date.now()}` },
      );
    }

    this.logger.warn('Recovered jobs left RUNNING by a previous worker', { count: stuck.length });
    return stuck.length;
  }
}
