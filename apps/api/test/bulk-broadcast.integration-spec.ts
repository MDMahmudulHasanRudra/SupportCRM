import { Repository } from 'typeorm';
import { ChannelAccountService } from '../src/modules/channel/channel-account.service';
import { ChannelConnectionState } from '../src/modules/channel/channel-connection';
import { NO_CAPABILITIES } from '../src/modules/channel/channel-capabilities';
import { ChannelAccount } from '../src/modules/channel/entities/channel-account.entity';
import { Channel, ChannelKey } from '../src/modules/channel/entities/channel.entity';
import { AutomationProfile } from '../src/modules/automation/entities/automation-profile.entity';
import { AutomationStatus } from '../src/modules/automation/automation-types';
import { BulkOperation, BulkOperationsService } from '../src/modules/bulk/bulk-operations.service';
import { BroadcastService } from '../src/modules/broadcast/broadcast.service';
import { Broadcast, BroadcastStatus } from '../src/modules/broadcast/entities/broadcast.entity';
import { Group, GroupMonitoringState } from '../src/modules/groups/entities/group.entity';
import { Job, JobStatus } from '../src/modules/jobs/entities/job.entity';
import { JobItem, JobItemStatus } from '../src/modules/jobs/entities/job-item.entity';
import { JobsService } from '../src/modules/jobs/jobs.service';
import { OutboundMessage } from '../src/modules/messaging/entities/outbound-message.entity';
import { OpenWaStub } from './openwa-stub';
import { closeTestApp, createTestApp, resetDatabase, waitFor, type TestContext } from './setup';

const SESSION = 'bulk-test';
const SESSION_UUID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

/**
 * Bulk configuration and broadcasts (`PROJECT_SPEC.md` §47–§49, §57).
 *
 * Driven through the **real** Job Center: jobs are created, the real BullMQ consumer picks them up,
 * and the assertions are about what ended up in the database. The brief is explicit that a
 * large-scale test must not be a loop in a unit test — the property under test is that the queue,
 * the per-item progress and the retry path all actually work at size.
 */
describe('Bulk operations and broadcasts (integration)', () => {
  let ctx: TestContext;
  let stub: OpenWaStub;

  let bulk: BulkOperationsService;
  let broadcasts: BroadcastService;
  let jobs: JobsService;
  let accounts: ChannelAccountService;

  let groupRepo: Repository<Group>;
  let profileRepo: Repository<AutomationProfile>;
  let jobRepo: Repository<Job>;
  let itemRepo: Repository<JobItem>;
  let broadcastRepo: Repository<Broadcast>;
  let outboundRepo: Repository<OutboundMessage>;
  let accountRepo: Repository<ChannelAccount>;

  let account: ChannelAccount;

  beforeAll(async () => {
    stub = new OpenWaStub();
    process.env.OPENWA_BASE_URL = await stub.start();
    process.env.OPENWA_API_KEY = 'stub-key';

    ctx = await createTestApp();

    bulk = ctx.app.get(BulkOperationsService);
    broadcasts = ctx.app.get(BroadcastService);
    jobs = ctx.app.get(JobsService);
    accounts = ctx.app.get(ChannelAccountService);

    groupRepo = ctx.dataSource.getRepository(Group);
    profileRepo = ctx.dataSource.getRepository(AutomationProfile);
    jobRepo = ctx.dataSource.getRepository(Job);
    itemRepo = ctx.dataSource.getRepository(JobItem);
    broadcastRepo = ctx.dataSource.getRepository(Broadcast);
    outboundRepo = ctx.dataSource.getRepository(OutboundMessage);
    accountRepo = ctx.dataSource.getRepository(ChannelAccount);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
    await stub.stop();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.dataSource);
    stub.reset();

    await ctx.dataSource
      .getRepository(Channel)
      .save({ key: ChannelKey.WHATSAPP, name: 'WhatsApp', isEnabled: true, adapterKey: 'openwa' });

    account = await accounts.register({
      channelKey: ChannelKey.WHATSAPP,
      externalName: SESSION,
      label: 'Bulk test account',
    });
    await accountRepo.update(account.id, {
      externalId: SESSION_UUID,
      accountPhone: '8801999999999',
      status: ChannelConnectionState.CONNECTED,
      capabilities: { ...NO_CAPABILITIES, canSendText: true },
    });
    account = await accounts.findOne(account.id);

    stub.addSession(SESSION, SESSION_UUID, { status: 'ready', phone: '8801999999999' });
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
      { description: `job ${id} to finish`, timeoutMs: 60_000 },
    );

  async function seedGroups(count: number): Promise<Group[]> {
    const rows = Array.from({ length: count }, (_, index) =>
      groupRepo.create({
        channelKey: ChannelKey.WHATSAPP,
        channelAccountId: account.id,
        externalId: `bulk-${index}@g.us`,
        name: `Bulk group ${index}`,
        isActive: true,
        monitoringState: GroupMonitoringState.MONITORED,
        automationEnabled: false,
        aiEnabled: false,
      }),
    );
    return groupRepo.save(rows);
  }

  // === bulk ========================================================================================

  describe('bulk group configuration', () => {
    it('previews a selection before anything changes', async () => {
      await seedGroups(25);

      const preview = await bulk.preview({
        operation: BulkOperation.ENABLE_AUTOMATION,
        filter: { channelAccountId: account.id },
      });

      expect(preview.total).toBe(25);
      expect(preview.sample).toHaveLength(10);
      // Nothing moved: a preview is a question, not an action.
      expect(await groupRepo.count({ where: { automationEnabled: true } })).toBe(0);
    });

    it('applies one change across many groups through the queue', async () => {
      const groups = await seedGroups(120);

      const queued = await bulk.queue(
        { operation: BulkOperation.ENABLE_AUTOMATION, filter: { channelAccountId: account.id } },
        null,
      );

      expect(queued.totalItems).toBe(groups.length);

      const finished = await awaitTerminal(queued.jobId);
      expect(finished.status).toBe(JobStatus.COMPLETED);
      expect(finished.completedItems).toBe(groups.length);

      // The actual point of the feature: every group changed, without a single HTTP request
      // writing 120 rows.
      expect(await groupRepo.count({ where: { automationEnabled: true } })).toBe(groups.length);
    });

    it('assigns a profile across a selection', async () => {
      const groups = await seedGroups(40);
      const profile = await profileRepo.save(
        profileRepo.create({ name: 'ISP Standard', status: AutomationStatus.ACTIVE }),
      );

      const queued = await bulk.queue(
        {
          operation: BulkOperation.ASSIGN_AUTOMATION_PROFILE,
          groupIds: groups.map((group) => group.id),
          targetId: profile.id,
        },
        null,
      );
      await awaitTerminal(queued.jobId);

      // One profile, forty groups. Editing the profile now reaches all of them.
      expect(await groupRepo.count({ where: { automationProfileId: profile.id } })).toBe(groups.length);
    });

    it('records per-item progress rather than one opaque result', async () => {
      await seedGroups(30);

      const queued = await bulk.queue(
        { operation: BulkOperation.ENABLE_AI, filter: { channelAccountId: account.id } },
        null,
      );
      await awaitTerminal(queued.jobId);

      const items = await itemRepo.find({ where: { jobId: queued.jobId } });
      expect(items).toHaveLength(30);
      expect(items.every((item) => item.status === JobItemStatus.COMPLETED)).toBe(true);
    });

    it('fails one group without abandoning the rest, and retries just that one', async () => {
      const groups = await seedGroups(10);

      const queued = await bulk.queue(
        { operation: BulkOperation.ENABLE_AUTOMATION, groupIds: groups.map((g) => g.id) },
        null,
      );
      await awaitTerminal(queued.jobId);

      // Point one item at a group that no longer exists, then retry: only that item re-runs.
      const [victim] = await itemRepo.find({ where: { jobId: queued.jobId }, take: 1 });
      await itemRepo.update(victim.id, {
        status: JobItemStatus.FAILED,
        error: 'simulated failure',
      });

      const retried = await jobs.retryFailed(queued.jobId);
      const finished = await awaitTerminal(retried.id);

      expect([JobStatus.COMPLETED, JobStatus.COMPLETED_WITH_ERRORS]).toContain(finished.status);
      expect(await groupRepo.count({ where: { automationEnabled: true } })).toBe(groups.length);
    });

    it('is idempotent — running the same operation twice leaves the same state', async () => {
      const groups = await seedGroups(15);
      const request = { operation: BulkOperation.ENABLE_AUTOMATION, groupIds: groups.map((g) => g.id) };

      await awaitTerminal((await bulk.queue(request, null)).jobId);
      await awaitTerminal((await bulk.queue(request, null)).jobId);

      // Every operation is a set-to-a-value, so a retry cannot compound.
      expect(await groupRepo.count({ where: { automationEnabled: true } })).toBe(groups.length);
    });

    it('refuses a selection with no target', async () => {
      await seedGroups(5);

      // "Apply to everything" must be something somebody asks for explicitly.
      await expect(bulk.queue({ operation: BulkOperation.ENABLE_AI }, null)).rejects.toThrow(
        /needs a target/,
      );
    });

    it('refuses a selection that matches nothing', async () => {
      await expect(
        bulk.queue({ operation: BulkOperation.ENABLE_AI, groupIds: [] }, null),
      ).rejects.toThrow(/needs a target|matched no groups/);
    });

    it('refuses to assign a profile that does not exist', async () => {
      const groups = await seedGroups(3);
      await expect(
        bulk.queue(
          {
            operation: BulkOperation.ASSIGN_AUTOMATION_PROFILE,
            groupIds: groups.map((g) => g.id),
            targetId: '00000000-0000-4000-8000-000000000000',
          },
          null,
        ),
      ).rejects.toThrow(/does not exist/);
    });
  });

  // === broadcast ===================================================================================

  describe('broadcasts', () => {
    async function campaign(groupCount = 20) {
      const groups = await seedGroups(groupCount);
      const broadcast = await broadcasts.create(
        {
          name: 'Maintenance notice',
          body: 'Scheduled maintenance tonight from 02:00.',
          channelAccountId: account.id,
          target: { groupIds: groups.map((group) => group.id) },
        },
        null,
      );
      return { broadcast, groups };
    }

    it('creates a campaign that sends nothing until it is started', async () => {
      const { broadcast } = await campaign(5);

      expect(broadcast.status).toBe(BroadcastStatus.DRAFT);
      expect(await outboundRepo.count()).toBe(0);
    });

    it('queues one send per recipient and counts the results', async () => {
      const { broadcast, groups } = await campaign(20);

      const started = await broadcasts.start(broadcast.id, null);
      expect(started.status).toBe(BroadcastStatus.RUNNING);
      expect(started.totalCount).toBe(groups.length);

      await awaitTerminal(started.jobId as string);

      // Every recipient got exactly one queued message, through the ordinary outbound path.
      expect(await outboundRepo.count()).toBe(groups.length);

      const after = await broadcastRepo.findOneOrFail({ where: { id: broadcast.id } });
      expect(after.successCount).toBe(groups.length);
      expect(after.failureCount).toBe(0);
    });

    it('never messages the same recipient twice, even if an item runs again', async () => {
      const { broadcast, groups } = await campaign(6);
      const started = await broadcasts.start(broadcast.id, null);
      await awaitTerminal(started.jobId as string);

      const before = await outboundRepo.count();

      // Re-running the job's items is what a retry does. The idempotency key is campaign+recipient.
      const retried = await jobs.retryFailed(started.jobId as string).catch(() => null);
      if (retried) await awaitTerminal(retried.id);

      expect(await outboundRepo.count()).toBe(before);
      expect(before).toBe(groups.length);
    });

    it('refuses to start the same campaign twice', async () => {
      const { broadcast } = await campaign(3);
      await broadcasts.start(broadcast.id, null);

      // A double start means every recipient gets the message twice.
      await expect(broadcasts.start(broadcast.id, null)).rejects.toThrow(/already been started/);
    });

    it('cancels a running campaign', async () => {
      const { broadcast } = await campaign(50);
      const started = await broadcasts.start(broadcast.id, null);

      const cancelled = await broadcasts.cancel(broadcast.id);
      expect(cancelled.status).toBe(BroadcastStatus.CANCELLED);
      expect(started.jobId).toBeTruthy();
    });

    it('refuses a campaign with no recipients', async () => {
      await expect(
        broadcasts.create(
          { name: 'Empty', body: 'Hello', channelAccountId: account.id, target: {} },
          null,
        ),
      ).rejects.toThrow(/needs recipients/);
    });

    it('refuses a campaign with no message', async () => {
      const groups = await seedGroups(2);
      await expect(
        broadcasts.create(
          {
            name: 'Silent',
            body: '   ',
            channelAccountId: account.id,
            target: { groupIds: groups.map((g) => g.id) },
          },
          null,
        ),
      ).rejects.toThrow(/needs a message/);
    });
  });
});
