import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThanOrEqual, Repository } from 'typeorm';
import { AppLogger } from '../../common/logging/app-logger';
import { MetricsService } from '../../common/metrics/metrics.service';
import { Conversation } from '../crm/entities/conversation.entity';
import { Group } from '../groups/entities/group.entity';
import { JobType } from '../jobs/entities/job.entity';
import { JobsService } from '../jobs/jobs.service';
import { EMERGENCY_STOPS, SettingsService } from '../settings/settings.service';
import { MessageService } from '../messaging/message.service';
import { OutboundSource } from '../messaging/entities/outbound-message.entity';
import { Broadcast, BroadcastStatus } from './entities/broadcast.entity';
import { BroadcastRecipient, BroadcastRecipientStatus } from './entities/broadcast-recipient.entity';

/**
 * Campaigns (`PROJECT_SPEC.md` §57, §197; brief §27).
 *
 * Queue-based, one Job Center item per recipient, sending through the **existing** outbound path —
 * which means every message a broadcast produces goes through the same rate limits, the same
 * emergency stop and the same ownership checks as any other send. A broadcast that bypassed those
 * would be the fastest way to get a WhatsApp account banned.
 *
 * Recipients are resolved when the campaign starts, not when it is created: a group added to the
 * target in between should be included, and one deleted should not be attempted.
 */
@Injectable()
export class BroadcastService {
  private readonly logger = new AppLogger(BroadcastService.name);

  constructor(
    @InjectRepository(Broadcast) private readonly broadcasts: Repository<Broadcast>,
    @InjectRepository(BroadcastRecipient) private readonly recipients: Repository<BroadcastRecipient>,
    // The single outbound control point. A test send is an ordinary message: rate-limited,
    // recorded and auditable like any other, rather than a side channel around the sender.
    private readonly messages: MessageService,
    @InjectRepository(Group) private readonly groups: Repository<Group>,
    @InjectRepository(Conversation) private readonly conversations: Repository<Conversation>,
    private readonly jobs: JobsService,
    private readonly settings: SettingsService,
    private readonly metrics: MetricsService,
  ) {}

  async findOne(id: string): Promise<Broadcast> {
    const broadcast = await this.broadcasts.findOne({ where: { id } });
    if (!broadcast) throw new NotFoundException(`Broadcast ${id} not found`);
    return broadcast;
  }

  async list(options: { status?: BroadcastStatus; limit?: number } = {}) {
    const [items, total] = await this.broadcasts.findAndCount({
      where: options.status ? { status: options.status } : {},
      order: { createdAt: 'DESC' },
      take: Math.min(options.limit ?? 50, 200),
    });
    return { items, total };
  }

  /** Creates a campaign as a DRAFT. Nothing is sent until somebody starts it. */
  async create(
    input: {
      name: string;
      body: string;
      channelAccountId: string;
      target: { groupIds?: string[]; conversationIds?: string[] };
      scheduledAt?: Date | null;
    },
    userId: string | null,
  ): Promise<Broadcast> {
    if (!input.body.trim()) throw new BadRequestException('A broadcast needs a message.');
    if (!input.target?.groupIds?.length && !input.target?.conversationIds?.length) {
      throw new BadRequestException('A broadcast needs recipients.');
    }

    return this.broadcasts.save(
      this.broadcasts.create({
        name: input.name.trim(),
        body: input.body,
        channelAccountId: input.channelAccountId,
        target: input.target,
        status: input.scheduledAt ? BroadcastStatus.SCHEDULED : BroadcastStatus.DRAFT,
        scheduledAt: input.scheduledAt ?? null,
        createdById: userId,
      }),
    );
  }

  /**
   * Resolves recipients and queues the sends.
   *
   * Refuses if the emergency broadcast switch is engaged, and refuses to start a campaign twice —
   * a double-started broadcast means every recipient gets the message twice.
   */
  async start(id: string, userId: string | null): Promise<Broadcast> {
    const broadcast = await this.findOne(id);

    if (broadcast.status === BroadcastStatus.RUNNING || broadcast.status === BroadcastStatus.COMPLETED) {
      throw new ConflictException('That broadcast has already been started.');
    }
    if (await this.settings.isStopped(EMERGENCY_STOPS.BROADCAST_DISABLED)) {
      throw new ConflictException('Broadcasts are disabled by the emergency control.');
    }

    const recipients = await this.resolveRecipients(broadcast);
    if (recipients.length === 0) throw new BadRequestException('That broadcast has no reachable recipients.');

    // Materialised now, once. The audience must not drift between the operator approving it and
    // the last batch going out (§196) — a group that gains a member mid-send would otherwise
    // receive a message nobody approved for them. It also makes a retried batch safe: the unique
    // index means a second row cannot exist, and a row already SENT is never sent again.
    await this.materialiseRecipients(broadcast, recipients);

    const job = await this.jobs.create({
      type: JobType.BROADCAST,
      name: `Broadcast — ${broadcast.name}`,
      payload: { broadcastId: broadcast.id, channelAccountId: broadcast.channelAccountId },
      items: recipients.map((recipient) => ({
        reference: recipient,
        payload: { broadcastId: broadcast.id, externalConversationId: recipient },
      })),
      createdById: userId,
    });

    await this.broadcasts.update(broadcast.id, {
      status: BroadcastStatus.RUNNING,
      jobId: job.id,
      startedAt: new Date(),
      totalCount: recipients.length,
    });

    this.metrics.increment('broadcast.started', {}, recipients.length);
    this.logger.log('Broadcast started', { broadcastId: broadcast.id, recipients: recipients.length });

    return this.findOne(broadcast.id);
  }

  /**
   * Cancels a running campaign.
   *
   * Cancels the Job Center job, which stops the worker between items. Messages already handed to
   * the outbound queue are not recalled — they have left, and pretending otherwise would be a lie
   * in the UI.
   */
  async cancel(id: string): Promise<Broadcast> {
    const broadcast = await this.findOne(id);
    if (broadcast.status !== BroadcastStatus.RUNNING && broadcast.status !== BroadcastStatus.SCHEDULED) {
      throw new ConflictException('Only a running or scheduled broadcast can be cancelled.');
    }

    if (broadcast.jobId) await this.jobs.requestCancel(broadcast.jobId).catch(() => undefined);
    await this.broadcasts.update(id, { status: BroadcastStatus.CANCELLED, completedAt: new Date() });

    return this.findOne(id);
  }

  /**
   * Sends the campaign to one address, so somebody can read it on a real phone before two thousand
   * people do (§97).
   *
   * Deliberately not counted as part of the campaign: it writes no recipient row, moves no counter,
   * and leaves the broadcast in DRAFT. What it does record is `testSentAt`, so "did anyone check
   * this?" is answerable from the row rather than from memory.
   */
  async testSend(id: string, externalConversationId: string, userId: string | null): Promise<Broadcast> {
    const broadcast = await this.findOne(id);

    if (await this.settings.isStopped(EMERGENCY_STOPS.OUTGOING_MESSAGES_STOPPED)) {
      throw new ConflictException('Outgoing messages are stopped by the emergency control.');
    }

    await this.messages.send({
      channelAccountId: broadcast.channelAccountId,
      externalConversationId,
      body: broadcast.body,
      source: OutboundSource.MANUAL,
      // Not tagged with broadcastId: a test is not part of the campaign, and tagging it would put
      // it in the campaign's counters and its rate-limit bucket.
      idempotencyKey: `broadcast-test:${id}:${externalConversationId}:${Date.now()}`,
      createdById: userId,
    });

    await this.broadcasts.update(id, { testSentAt: new Date() });
    this.metrics.increment('broadcast.test_sent');

    return this.findOne(id);
  }

  /**
   * Starts every scheduled broadcast whose time has come.
   *
   * Called by the worker's sweep. Each start is independent: one campaign failing to start must not
   * hold up the others, so failures are logged against their own broadcast and the loop continues.
   */
  async startDue(now = new Date()): Promise<{ started: number; failed: number }> {
    const due = await this.broadcasts.find({
      where: { status: BroadcastStatus.SCHEDULED, scheduledAt: LessThanOrEqual(now) },
      order: { scheduledAt: 'ASC' },
      take: 10,
    });

    let started = 0;
    let failed = 0;

    for (const broadcast of due) {
      try {
        await this.start(broadcast.id, broadcast.createdById);
        started += 1;
      } catch (error) {
        failed += 1;
        this.logger.warn('A scheduled broadcast could not be started', {
          broadcastId: broadcast.id,
          error: (error as Error).message,
        });
        await this.broadcasts.update(broadcast.id, { status: BroadcastStatus.FAILED });
      }
    }

    return { started, failed };
  }

  /** Counters, moved by the worker as each recipient succeeds or fails. */
  async recordOutcome(broadcastId: string, outcome: 'success' | 'failure'): Promise<void> {
    const column = outcome === 'success' ? 'successCount' : 'failureCount';
    await this.broadcasts
      .createQueryBuilder()
      .update(Broadcast)
      .set({ [column]: () => `"${column}" + 1` })
      .where('id = :id', { id: broadcastId })
      .execute();
  }

  async complete(broadcastId: string): Promise<void> {
    await this.broadcasts.update(broadcastId, {
      status: BroadcastStatus.COMPLETED,
      completedAt: new Date(),
    });
  }

  /**
   * Writes one row per intended recipient.
   *
   * `orIgnore` rather than a pre-check: starting a broadcast twice is exactly the race this table
   * exists to survive, and the database settles it without a read-then-write window.
   */
  private async materialiseRecipients(broadcast: Broadcast, recipients: string[]): Promise<void> {
    const groups = broadcast.target.groupIds?.length
      ? await this.groups.find({ where: { id: In(broadcast.target.groupIds) } })
      : [];
    const byExternalId = new Map(groups.map((group) => [group.externalId, group]));

    const rows = recipients.map((externalConversationId) => {
      const group = byExternalId.get(externalConversationId);
      return {
        broadcastId: broadcast.id,
        externalConversationId,
        groupId: group?.id ?? null,
        displayName: group?.name ?? null,
        status: BroadcastRecipientStatus.PENDING,
      };
    });

    // Chunked: one INSERT with several thousand VALUES rows exceeds parameter limits on real
    // campaigns, which is precisely the size this feature exists for.
    for (let index = 0; index < rows.length; index += 500) {
      await this.recipients
        .createQueryBuilder()
        .insert()
        .into(BroadcastRecipient)
        .values(rows.slice(index, index + 500))
        .orIgnore()
        .execute();
    }
  }

  /**
   * Records what happened to one recipient.
   *
   * Called by the worker. Only ever moves a recipient to a status that describes something that
   * actually happened (§195): SENT when the gateway accepted it, FAILED with the reason, SKIPPED
   * when it was excluded before sending.
   */
  async markRecipient(
    broadcastId: string,
    externalConversationId: string,
    status: BroadcastRecipientStatus,
    detail?: { outboundMessageId?: string | null; failureReason?: string | null; skippedReason?: string | null },
  ): Promise<void> {
    await this.recipients.update(
      { broadcastId, externalConversationId },
      {
        status,
        outboundMessageId: detail?.outboundMessageId ?? null,
        failureReason: detail?.failureReason?.slice(0, 500) ?? null,
        skippedReason: detail?.skippedReason?.slice(0, 200) ?? null,
        sentAt: status === BroadcastRecipientStatus.SENT ? new Date() : null,
      },
    );
  }

  /** Whether this recipient has already been written to — the worker's idempotency check. */
  async alreadySent(broadcastId: string, externalConversationId: string): Promise<boolean> {
    const row = await this.recipients.findOne({ where: { broadcastId, externalConversationId } });
    return row?.status === BroadcastRecipientStatus.SENT || row?.status === BroadcastRecipientStatus.DELIVERED;
  }

  /** The per-recipient outcome list, for the campaign report. */
  async recipientsFor(broadcastId: string, status?: BroadcastRecipientStatus, limit = 100) {
    const [items, total] = await this.recipients.findAndCount({
      where: { broadcastId, ...(status ? { status } : {}) },
      order: { createdAt: 'ASC' },
      take: Math.min(limit, 500),
    });
    return { items, total };
  }

  /**
   * What this broadcast would reach, without starting it (§97).
   *
   * Exclusions are named rather than silently dropped: an operator who expected 300 recipients and
   * sees 280 needs to know which twenty fell out and why.
   */
  async preview(id: string): Promise<{
    total: number;
    sample: Array<{ externalConversationId: string; displayName: string | null }>;
    exclusions: Array<{ reason: string; count: number }>;
  }> {
    const broadcast = await this.findOne(id);
    const reachable = await this.resolveRecipients(broadcast);

    const requested =
      (broadcast.target.groupIds?.length ?? 0) + (broadcast.target.conversationIds?.length ?? 0);

    const exclusions: Array<{ reason: string; count: number }> = [];
    if (requested > reachable.length) {
      exclusions.push({
        reason: 'Inactive or unreachable — the group is archived, or has no address on this account.',
        count: requested - reachable.length,
      });
    }

    const groups = broadcast.target.groupIds?.length
      ? await this.groups.find({ where: { id: In(broadcast.target.groupIds) } })
      : [];
    const names = new Map(groups.map((group) => [group.externalId, group.name]));

    return {
      total: reachable.length,
      sample: reachable.slice(0, 10).map((externalConversationId) => ({
        externalConversationId,
        displayName: names.get(externalConversationId) ?? null,
      })),
      exclusions,
    };
  }

  private async resolveRecipients(broadcast: Broadcast): Promise<string[]> {
    const recipients = new Set<string>();

    if (broadcast.target.groupIds?.length) {
      const groups = await this.groups.find({
        where: { id: In(broadcast.target.groupIds), isActive: true },
        select: { externalId: true },
      });
      for (const group of groups) recipients.add(group.externalId);
    }

    if (broadcast.target.conversationIds?.length) {
      const conversations = await this.conversations.find({
        where: { id: In(broadcast.target.conversationIds) },
        select: { externalConversationId: true },
      });
      for (const conversation of conversations) recipients.add(conversation.externalConversationId);
    }

    return [...recipients];
  }
}
