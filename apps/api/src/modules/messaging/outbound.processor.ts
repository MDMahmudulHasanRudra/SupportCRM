import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { AppLogger } from '../../common/logging/app-logger';
import { MetricsService } from '../../common/metrics/metrics.service';
import { RateLimitService } from '../../common/redis/rate-limit.service';
import { RateLimitScope } from '../settings/entities/rate-limit-policy.entity';
import { RateLimitPolicyService } from '../settings/rate-limit-policy.service';
import { ChannelRegistryService } from '../channel/channel-registry.service';
import { ChannelConnectionState, canSendInState } from '../channel/channel-connection';
import { normalizeCapabilities } from '../channel/channel-capabilities';
import { ChannelAccount } from '../channel/entities/channel-account.entity';
import { ConversationResolverService } from '../crm/conversation-resolver.service';
import type { Conversation } from '../crm/entities/conversation.entity';
import type { ChannelKey } from '../channel/entities/channel.entity';
import { QUEUES } from '../jobs/queues';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { EMERGENCY_STOPS, SettingsService } from '../settings/settings.service';
import { OutboundMessage } from './entities/outbound-message.entity';
import { Message } from './entities/message.entity';
import { DeliveryStatus, MessageDirection, MessageProcessingStatus } from './message-types';

/**
 * Rate-limit defaults (brief §16).
 *
 * Conservative, and every one is a **default**, not a constant: each is overridable through
 * settings, so an operator can tune them without a redeploy (`PROJECT_SPEC.md` §57 requires them to
 * be configurable). WhatsApp does not publish limits, and sending fast is an account-safety risk
 * (§175), so the defaults err slow.
 */
const RATE_LIMIT_DEFAULTS = {
  perAccountPerMinute: 20,
  perAccountPerHour: 500,
  perConversationPerMinute: 5,
};

/**
 * The one consumer that calls a channel adapter's `send()`.
 *
 * Nothing else in the application may. Automation, AI and controllers all create
 * `outbound_messages` rows through `MessageService`, and those rows arrive here (brief §12).
 *
 * Every send re-validates from scratch. The checks `MessageService` performed at enqueue time were
 * true then; a message can sit in the queue while an operator hits emergency stop, the session
 * drops, or ownership is revoked — so the state at *send* time is what governs
 * (`PROJECT_SPEC.md` §194).
 */
@Injectable()
@Processor(QUEUES.MESSAGE_OUTGOING)
export class OutboundProcessor extends WorkerHost {
  private readonly logger = new AppLogger(OutboundProcessor.name);

  constructor(
    @InjectRepository(OutboundMessage) private readonly outbound: Repository<OutboundMessage>,
    @InjectRepository(Message) private readonly messages: Repository<Message>,
    @InjectRepository(ChannelAccount) private readonly accounts: Repository<ChannelAccount>,
    private readonly registry: ChannelRegistryService,
    private readonly settings: SettingsService,
    private readonly rateLimits: RateLimitService,
    private readonly policies: RateLimitPolicyService,
    private readonly realtime: RealtimeGateway,
    private readonly metrics: MetricsService,
    private readonly conversationResolver: ConversationResolverService,
  ) {
    super();
  }

  async process(job: Job<{ outboundMessageId: string }>): Promise<void> {
    const row = await this.outbound.findOne({ where: { id: job.data.outboundMessageId } });
    if (!row) {
      this.logger.warn('Outbound row missing for queued send', { outboundMessageId: job.data.outboundMessageId });
      return;
    }

    // At-least-once delivery means this job can arrive twice. Only a QUEUED row may be sent — the
    // guard that stops a redelivered job from sending the same message to a customer again.
    if (row.status !== DeliveryStatus.QUEUED) {
      this.metrics.increment('outbound.job_duplicate', { status: row.status });
      return;
    }

    this.metrics.observeDuration('outbound.queue_latency_ms', Date.now() - row.createdAt.getTime());

    const account = await this.accounts.findOne({ where: { id: row.channelAccountId } });
    if (!account) {
      await this.fail(row, 'The channel account no longer exists', { retryable: false });
      return;
    }

    const blocked = await this.preSendChecks(row, account);
    if (blocked) return;

    await this.outbound.update(row.id, {
      status: DeliveryStatus.SENDING,
      attempts: row.attempts + 1,
      lastAttemptAt: new Date(),
    });

    const adapter = this.registry.get(account.channelKey as ChannelKey);

    let result;
    try {
      result = await this.metrics.time('outbound.send_ms', () =>
        adapter.send({
          channelAccountId: account.id,
          externalConversationId: row.externalConversationId,
          body: row.body ?? '',
          quotedExternalId: row.quotedExternalId,
          attachments: (row.attachments ?? []) as never,
          idempotencyKey: row.idempotencyKey ?? row.id,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Back to QUEUED so BullMQ's backoff can retry — and so the "only QUEUED may send" guard
      // above still holds on the retry.
      await this.outbound.update(row.id, { status: DeliveryStatus.QUEUED, failureReason: message.slice(0, 2000) });
      this.metrics.increment('outbound.send_error');
      throw error;
    }

    if (result.status === 'failed') {
      await this.fail(row, result.error ?? 'The channel rejected the message', { retryable: false });
      return;
    }

    await this.recordSent(row, account, result.externalId);
  }

  /**
   * Pre-send re-validation (`PROJECT_SPEC.md` §194).
   *
   * Returns true when the send was blocked and the row already updated. Order runs cheapest and
   * most-absolute first: an emergency stop should not wait on a rate-limit round trip.
   */
  private async preSendChecks(row: OutboundMessage, account: ChannelAccount): Promise<boolean> {
    if (await this.settings.isStopped(EMERGENCY_STOPS.OUTGOING_MESSAGES_STOPPED)) {
      // CANCELLED, not FAILED: an emergency stop is a deliberate operator decision, and retrying it
      // later would defeat the control.
      await this.cancel(row, 'Outgoing messages are stopped by the emergency control');
      return true;
    }

    if (!account.ownershipEnabled) {
      await this.cancel(row, 'Support CRM no longer owns this channel account');
      return true;
    }

    if (!canSendInState(account.status as ChannelConnectionState)) {
      // Deferred, not failed: a disconnected session usually comes back, and a queued reply to a
      // customer should survive a brief reconnect.
      await this.defer(row, `Account is ${account.status}`, 60_000);
      return true;
    }

    const capabilities = normalizeCapabilities(account.capabilities);
    if (row.quotedExternalId && !capabilities.canReply) {
      await this.fail(row, 'This account cannot send replies', { retryable: false });
      return true;
    }
    if (row.attachments?.length && !capabilities.canSendMedia) {
      await this.fail(row, 'This account cannot send media', { retryable: false });
      return true;
    }
    if (!row.attachments?.length && !capabilities.canSendText) {
      await this.fail(row, 'This account cannot send text messages', { retryable: false });
      return true;
    }

    return this.checkRateLimits(row, account);
  }

  /**
   * Account- and conversation-level rate limits (brief §16).
   *
   * Exceeding a limit **defers**, it never fails: the message is still wanted, just not yet. The
   * delay is the window's own reset time, so a deferred message returns exactly when quota frees
   * rather than on a guessed schedule.
   */
  private async checkRateLimits(row: OutboundMessage, account: ChannelAccount): Promise<boolean> {
    const perMinute = await this.settings.get<number>(
      'channel.rate_limit.account_per_minute',
      RATE_LIMIT_DEFAULTS.perAccountPerMinute,
    );
    const perHour = await this.settings.get<number>(
      'channel.rate_limit.account_per_hour',
      RATE_LIMIT_DEFAULTS.perAccountPerHour,
    );
    const perConversation = await this.settings.get<number>(
      'channel.rate_limit.conversation_per_minute',
      RATE_LIMIT_DEFAULTS.perConversationPerMinute,
    );

    // The configurable policies of §57, resolved per subject: a specific row for this session or
    // destination, else the scope default, else the code default. These sit alongside the two
    // long-standing account settings above rather than replacing them — the account limits protect
    // the WhatsApp account, and these protect individual recipients and campaigns.
    const [session, destination, campaign] = await Promise.all([
      this.policies.resolve(RateLimitScope.SESSION, account.id),
      this.policies.resolve(RateLimitScope.DESTINATION),
      row.broadcastId
        ? this.policies.resolve(RateLimitScope.BROADCAST, row.broadcastId)
        : Promise.resolve(null),
    ]);

    // peek() first, consume() only once every limit passes — otherwise a message blocked by the
    // third limit would still have burned quota against the first two.
    const checks = [
      { scope: `account:${account.id}`, limit: perMinute, windowMs: 60_000, name: 'account_per_minute' },
      { scope: `account:${account.id}`, limit: perHour, windowMs: 3_600_000, name: 'account_per_hour' },
      {
        scope: `conversation:${account.id}:${row.externalConversationId}`,
        limit: perConversation,
        windowMs: 60_000,
        name: 'conversation_per_minute',
      },
      {
        scope: `rl:SESSION:${account.id}`,
        limit: session.limit,
        windowMs: session.windowSeconds * 1000,
        name: 'session_policy',
      },
      {
        // Per individual recipient: repeatedly messaging one person is what reads as harassment,
        // to a platform and to the person.
        scope: `rl:DESTINATION:${row.externalConversationId}`,
        limit: destination.limit,
        windowMs: destination.windowSeconds * 1000,
        name: 'destination_policy',
      },
      ...(campaign && row.broadcastId
        ? [
            {
              scope: `rl:BROADCAST:${row.broadcastId}`,
              limit: campaign.limit,
              windowMs: campaign.windowSeconds * 1000,
              name: 'broadcast_policy',
            },
          ]
        : []),
    ];

    for (const check of checks) {
      const usage = await this.rateLimits.peek(check.scope, check.limit, check.windowMs);
      if (!usage.allowed) {
        this.metrics.increment('outbound.rate_limited', { limit: check.name });
        await this.defer(row, `Rate limit ${check.name} reached`, usage.resetInMs);
        return true;
      }
    }

    for (const check of checks) {
      await this.rateLimits.consume(check.scope, check.limit, check.windowMs);
    }
    return false;
  }

  /** Records a successful send and creates the corresponding `messages` row. */
  private async recordSent(
    row: OutboundMessage,
    account: ChannelAccount,
    externalId: string | null,
  ): Promise<void> {
    const sentAt = new Date();

    await this.outbound.update(row.id, {
      status: DeliveryStatus.SENT,
      externalMessageId: externalId,
      sentAt,
      failureReason: null,
    });

    // The conversation this message belongs to, created on first sight.
    //
    // An operator messaging a destination for the first time is the moment that conversation begins,
    // and without this the message would be logged with no conversation and never appear in the
    // inbox. Shares `resolveForOutbound` with the inbound path, so a chat lands in exactly one
    // conversation whichever direction spoke first; the unique index on
    // (channelAccountId, externalConversationId) arbitrates two sends racing.
    let resolved: { conversation: Conversation; created: boolean } | null = null;
    try {
      resolved = await this.conversationResolver.resolveForOutbound(account, row.externalConversationId);
    } catch (error) {
      // A message that reached WhatsApp must never be un-recorded because the CRM could not file it.
      this.logger.error('Could not resolve a conversation for a sent message', {
        outboundMessageId: row.id,
        error: (error as Error).message,
      });
    }

    // The message log row. Insert-and-catch: the gateway may already have delivered a
    // `message.sent` webhook for this very message, and whichever arrives second must not fail.
    if (externalId) {
      try {
        const entity = this.messages.create({
            channelKey: account.channelKey as ChannelKey,
            channelAccountId: account.id,
            externalId,
            externalConversationId: row.externalConversationId,
            externalGroupId: resolved?.conversation.groupId ? row.externalConversationId : null,
            groupId: resolved?.conversation.groupId ?? null,
            conversationId: resolved?.conversation.id ?? null,
            direction: MessageDirection.OUTBOUND,
            // The account's own identity on the channel, not the gateway session id.
            senderExternalId: account.accountPhone ?? account.externalName,
            senderPhone: null,
            senderDisplayName: account.displayIdentity,
            contentType: row.contentType,
            body: row.body,
            quotedExternalId: row.quotedExternalId,
            classification: 'BOT_MESSAGE' as never,
            fromAccount: true,
            sentAt,
            processingStatus: MessageProcessingStatus.PROCESSED,
            deliveryStatus: DeliveryStatus.SENT,
            outboundMessageId: row.id,
        });
        const message = await this.messages.save(entity);
        await this.outbound.update(row.id, { messageId: message.id });
      } catch (error) {
        if ((error as { code?: string }).code !== '23505') throw error;
        // The webhook won the race and already logged it — link to that row instead, and backfill
        // the conversation if the webhook logged it before one existed.
        const existing = await this.messages.findOne({
          where: { channelAccountId: account.id, externalId },
        });
        if (existing) {
          await this.messages.update(existing.id, {
            outboundMessageId: row.id,
            ...(existing.conversationId ? {} : { conversationId: resolved?.conversation.id ?? null }),
          });
          await this.outbound.update(row.id, { messageId: existing.id });
        }
      }
    }

    if (resolved) {
      // Counters and inbox ordering. `inbound: false` and `fromCustomer: false` — our own message
      // must not reopen a resolved conversation, which is the inbound reopen rule's whole point.
      await this.conversationResolver
        .recordActivity(resolved.conversation, { at: sentAt, inbound: false, fromCustomer: false })
        .catch(() => undefined);

      if (resolved.created) this.conversationResolver.emitCreated(resolved.conversation);
    }

    this.metrics.increment('outbound.sent', { source: row.source });
    this.realtime.emitWhatsAppEvent('whatsapp.message.sent', {
      channelAccountId: account.id,
      outboundMessageId: row.id,
      externalMessageId: externalId,
      externalConversationId: row.externalConversationId,
      status: DeliveryStatus.SENT,
    });

    this.logger.log('Outbound message sent', {
      outboundMessageId: row.id,
      channelAccountId: account.id,
      externalMessageId: externalId,
    });
  }

  private async fail(row: OutboundMessage, reason: string, options: { retryable: boolean }): Promise<void> {
    await this.outbound.update(row.id, {
      status: options.retryable ? DeliveryStatus.QUEUED : DeliveryStatus.FAILED,
      failureReason: reason.slice(0, 2000),
    });
    this.metrics.increment('outbound.failed');
    this.realtime.emitWhatsAppEvent('whatsapp.error', {
      channelAccountId: row.channelAccountId,
      outboundMessageId: row.id,
      reason: reason.slice(0, 200),
    });
    this.logger.warn('Outbound message failed', { outboundMessageId: row.id, reason });
  }

  private async cancel(row: OutboundMessage, reason: string): Promise<void> {
    await this.outbound.update(row.id, {
      status: DeliveryStatus.CANCELLED,
      failureReason: reason.slice(0, 2000),
    });
    this.metrics.increment('outbound.cancelled');
    this.logger.warn('Outbound message cancelled before dispatch', { outboundMessageId: row.id, reason });
  }

  /** Leaves the row QUEUED and pushes `scheduledAt` out, so the retry has a defined moment. */
  private async defer(row: OutboundMessage, reason: string, delayMs: number): Promise<void> {
    const delay = Math.min(Math.max(delayMs, 1_000), 15 * 60_000);
    await this.outbound.update(row.id, {
      status: DeliveryStatus.QUEUED,
      scheduledAt: new Date(Date.now() + delay),
      failureReason: reason.slice(0, 2000),
    });
    this.metrics.increment('outbound.deferred');
    this.logger.debug('Outbound message deferred', { outboundMessageId: row.id, reason, delayMs: delay });
    // Throwing hands the retry to BullMQ's backoff. Returning normally would mark the job complete
    // and the row would sit QUEUED with nothing scheduled to pick it up again.
    throw new Error(`Deferred: ${reason}`);
  }
}
