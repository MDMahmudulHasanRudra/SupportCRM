import { Repository } from 'typeorm';
import { JobsService } from '../src/modules/jobs/jobs.service';
import { JobProcessor } from '../src/modules/jobs/job.processor';
import { Job, JobStatus, JobType } from '../src/modules/jobs/entities/job.entity';
import { JobItem, JobItemStatus } from '../src/modules/jobs/entities/job-item.entity';
import { closeTestApp, createTestApp, resetDatabase, waitFor, type TestContext } from './setup';

/**
 * Phase 1 acceptance criterion 3: "A job runs end-to-end through Redis with visible progress and a
 * working retry."
 *
 * The suite boots in worker mode so the real BullMQ consumer is registered — jobs are genuinely
 * enqueued to Redis, picked up by the processor, and observed through their durable Postgres rows.
 * Nothing here is simulated.
 */
describe('Job Center (integration)', () => {
  let ctx: TestContext;
  let jobs: JobsService;
  let jobRepo: Repository<Job>;
  let itemRepo: Repository<JobItem>;

  beforeAll(async () => {
    // RUN_MODE=worker is set in test/setup.ts, before the module graph is built.
    ctx = await createTestApp();
    jobs = ctx.app.get(JobsService);
    jobRepo = ctx.dataSource.getRepository(Job);
    itemRepo = ctx.dataSource.getRepository(JobItem);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await resetDatabase(ctx.dataSource);
  });

  const awaitTerminal = (id: string) =>
    waitFor(
      async () => {
        const job = await jobRepo.findOne({ where: { id } });
        const terminal = [
          JobStatus.COMPLETED,
          JobStatus.COMPLETED_WITH_ERRORS,
          JobStatus.FAILED,
          JobStatus.CANCELLED,
        ];
        return job && terminal.includes(job.status) ? job : null;
      },
      { description: `job ${id} to reach a terminal state` },
    );

  it('runs a job end to end through Redis', async () => {
    const created = await jobs.create({
      type: JobType.SYSTEM_ECHO,
      name: 'echo smoke test',
      items: [{ reference: 'a' }, { reference: 'b' }, { reference: 'c' }],
    });
    expect(created.status).toBe(JobStatus.QUEUED);
    expect(created.totalItems).toBe(3);

    const finished = await awaitTerminal(created.id);
    expect(finished.status).toBe(JobStatus.COMPLETED);
    expect(finished.completedItems).toBe(3);
    expect(finished.failedItems).toBe(0);
    expect(finished.progressPercent).toBe(100);
    expect(finished.startedAt).not.toBeNull();
    expect(finished.finishedAt).not.toBeNull();

    const items = await itemRepo.find({ where: { jobId: created.id } });
    expect(items.every((i) => i.status === JobItemStatus.COMPLETED)).toBe(true);
    expect(items.every((i) => i.result !== null)).toBe(true);
  });

  it('records each item’s failure without failing the whole job', async () => {
    const created = await jobs.create({
      type: JobType.SYSTEM_ECHO,
      name: 'partial failure',
      items: [{ reference: 'ok-1' }, { reference: 'fail:boom' }, { reference: 'ok-2' }],
    });

    const finished = await awaitTerminal(created.id);
    // Distinct from COMPLETED — partial success must be visible, not rounded to success or failure.
    expect(finished.status).toBe(JobStatus.COMPLETED_WITH_ERRORS);
    expect(finished.completedItems).toBe(2);
    expect(finished.failedItems).toBe(1);

    const failed = await itemRepo.findOneOrFail({
      where: { jobId: created.id, status: JobItemStatus.FAILED },
    });
    expect(failed.reference).toBe('fail:boom');
    expect(failed.error).toMatch(/Simulated failure/);
  });

  it('retries only the failed items — successes are never re-run', async () => {
    const created = await jobs.create({
      type: JobType.SYSTEM_ECHO,
      name: 'retry',
      items: [{ reference: 'ok-1' }, { reference: 'fail:one' }, { reference: 'fail:two' }],
    });
    await awaitTerminal(created.id);

    const successBefore = await itemRepo.findOneOrFail({
      where: { jobId: created.id, reference: 'ok-1' },
    });

    await jobs.retryFailed(created.id);
    const afterRetry = await awaitTerminal(created.id);

    // Still failing (the echo handler fails deterministically), but the point is the accounting.
    expect(afterRetry.failedItems).toBe(2);

    const successAfter = await itemRepo.findOneOrFail({
      where: { jobId: created.id, reference: 'ok-1' },
    });
    expect(successAfter.attempts).toBe(successBefore.attempts);
    expect(successAfter.processedAt).toEqual(successBefore.processedAt);

    const retried = await itemRepo.findOneOrFail({ where: { jobId: created.id, reference: 'fail:one' } });
    expect(retried.attempts).toBe(2);
  });

  it('refuses to retry a job with nothing failed', async () => {
    const created = await jobs.create({
      type: JobType.SYSTEM_ECHO,
      name: 'clean',
      items: [{ reference: 'ok' }],
    });
    await awaitTerminal(created.id);
    await expect(jobs.retryFailed(created.id)).rejects.toThrow(/no failed items/i);
  });

  it('is idempotent on the same key — a double-submitted request creates one job', async () => {
    const first = await jobs.create({
      type: JobType.SYSTEM_ECHO,
      name: 'idempotent',
      items: [{ reference: 'a' }],
      idempotencyKey: 'the-same-key',
    });
    const second = await jobs.create({
      type: JobType.SYSTEM_ECHO,
      name: 'idempotent (double click)',
      items: [{ reference: 'a' }],
      idempotencyKey: 'the-same-key',
    });

    expect(second.id).toBe(first.id);
    expect(await jobRepo.count()).toBe(1);
  });

  it('enforces idempotency at the database level too, not only in the service', async () => {
    await jobs.create({
      type: JobType.SYSTEM_ECHO,
      name: 'db-level',
      items: [{ reference: 'a' }],
      idempotencyKey: 'db-key',
    });

    // The partial unique index is the real guarantee — two API replicas can race the service check.
    await expect(
      ctx.dataSource.query(
        `INSERT INTO jobs (type, name, "idempotencyKey", "totalItems") VALUES ($1, $2, $3, 1)`,
        [JobType.SYSTEM_ECHO, 'race', 'db-key'],
      ),
    ).rejects.toThrow();
  });

  it('allows many jobs with no idempotency key (the index is partial)', async () => {
    await jobs.create({ type: JobType.SYSTEM_ECHO, name: 'a', items: [{ reference: '1' }] });
    await jobs.create({ type: JobType.SYSTEM_ECHO, name: 'b', items: [{ reference: '1' }] });
    expect(await jobRepo.count()).toBe(2);
  });

  it('cancels a queued job immediately and marks its pending items cancelled', async () => {
    const created = await jobs.create({
      type: JobType.SYSTEM_ECHO,
      name: 'cancel me',
      items: Array.from({ length: 20 }, (_, i) => ({ reference: `r-${i}` })),
    });

    await jobs.requestCancel(created.id);
    const finished = await awaitTerminal(created.id);
    expect(finished.status).toBe(JobStatus.CANCELLED);

    const pending = await itemRepo.count({
      where: { jobId: created.id, status: JobItemStatus.PENDING },
    });
    expect(pending).toBe(0);
  });

  it('rejects a job with no items instead of completing an empty job', async () => {
    await expect(
      jobs.create({ type: JobType.SYSTEM_ECHO, name: 'empty', items: [] }),
    ).rejects.toThrow(/at least one item/);
  });

  it('fails loudly for an unregistered job type rather than reporting silent success', async () => {
    const created = await jobs.create({
      // A type with no handler. KNOWLEDGE_INDEX played this role until Phase 4 gave it one;
      // EXPORT is the next type whose handler has not been written yet.
      type: JobType.EXPORT,
      name: 'unhandled',
      items: [{ reference: 'doc-1' }],
    });

    const finished = await awaitTerminal(created.id);
    expect(finished.status).toBe(JobStatus.FAILED);
    expect(finished.error).toMatch(/No handler registered/);
  });

  it('creates the job and its items atomically', async () => {
    const created = await jobs.create({
      type: JobType.SYSTEM_ECHO,
      name: 'atomic',
      items: Array.from({ length: 750 }, (_, i) => ({ reference: `bulk-${i}` })),
    });
    expect(await itemRepo.count({ where: { jobId: created.id } })).toBe(750);
    expect(created.totalItems).toBe(750);
  });

  it('deletes items with their job (cascade), leaving no orphans', async () => {
    const created = await jobs.create({
      type: JobType.SYSTEM_ECHO,
      name: 'cascade',
      items: [{ reference: 'a' }],
    });
    await awaitTerminal(created.id);
    await jobRepo.delete(created.id);
    expect(await itemRepo.count({ where: { jobId: created.id } })).toBe(0);
  });

  it('requeues jobs a crashed worker left RUNNING', async () => {
    const created = await jobs.create({
      type: JobType.SYSTEM_ECHO,
      name: 'crashed',
      items: [{ reference: 'a' }],
    });
    await awaitTerminal(created.id);

    // Simulate the state a hard-killed worker leaves behind.
    await jobRepo.update(created.id, { status: JobStatus.RUNNING, finishedAt: null });
    await itemRepo.update({ jobId: created.id }, { status: JobItemStatus.PROCESSING });

    expect(await jobs.recoverStuckJobs()).toBe(1);

    const recovered = await awaitTerminal(created.id);
    expect(recovered.status).toBe(JobStatus.COMPLETED);
  });

  it('lets only one worker process a job at a time', async () => {
    const processor = ctx.app.get(JobProcessor);
    const created = await jobs.create({
      type: JobType.SYSTEM_ECHO,
      name: 'lock',
      items: Array.from({ length: 30 }, (_, i) => ({ reference: `r-${i}` })),
    });

    // Two concurrent deliveries of the same job — what two worker replicas would produce.
    await Promise.all([
      processor.process({ data: { jobId: created.id } } as never),
      processor.process({ data: { jobId: created.id } } as never),
    ]);

    const finished = await jobRepo.findOneOrFail({ where: { id: created.id } });
    // Each item processed exactly once: counts must equal the item count, never double it.
    expect(finished.completedItems).toBe(30);
    expect(await itemRepo.count({ where: { jobId: created.id, status: JobItemStatus.COMPLETED } })).toBe(30);
  });
});
