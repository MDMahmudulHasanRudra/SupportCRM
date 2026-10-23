import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable,Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { AppLogger } from '../../common/logging/app-logger';
import { MetricsService } from '../../common/metrics/metrics.service';
import { LockService } from '../../common/redis/lock.service';
import { ChannelAccount } from '../channel/entities/channel-account.entity';
import { ChannelConnectionState, ConnectionEventSource } from '../channel/channel-connection';
import { ChannelRegistryService } from '../channel/channel-registry.service';
import type { ChannelKey } from '../channel/entities/channel.entity';
import { ChannelAccountService } from '../channel/channel-account.service';
import { ProviderEvent, ProviderEventStatus } from '../ingestion/entities/provider-event.entity';
import { QUEUES } from '../jobs/queues';
import { Conversation } from '../crm/entities/conversation.entity';
import { DecisionService } from '../decision/decision.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ChannelLabelService,type NormalizedChannelLabel } from './channel-label.service';
import { MessagePresentationService } from './message-presentation.service';
import { InboundMessageService } from './inbound-message.service';
import { DeliveryService } from './delivery.service';
import { MessageClassification, MessageProcessingStatus } from './message-types';

/**
 * Which messages reach the Decision Engine.
 *
 * Mirrors `ANSWERABLE` in the engine, which is the authority on the rule and explains why UNKNOWN
 * is in the list. Checked here too so a team message or our own echo never even builds a decision
 * context.
 */
const ENGINE_CLASSIFICATIONS: readonly MessageClassification[] = [
  MessageClassification.CUSTOMER_MESSAGE,
  MessageClassification.UNKNOWN,
];

/**
 * How long a conversation lock is held while one inbound event is processed.
 *
 * Short by design. `PROJECT_SPEC.md` §186 requires that two workers never process the same
 * conversation concurrently, but Phase 2's work per event is a handful of queries — a long TTL
 * would only mean a crashed worker blocking that conversation for longer than necessary.
 */
const CONVERSATION_LOCK_TTL_MS = 30_000;

/**
 * Consumes verified provider events.
 *
 * Everything the webhook deliberately did not do happens here: normalization, classification,
 * persistence, delivery receipts and session-state updates. `PROJECT_SPEC.md` §6 and the brief §14
 * both require this split — the webhook must acknowledge fast, or the gateway retries and
 * manufactures duplicates.
 *
 * This processor decides nothing about *replying*. No automation, no AI, no escalation. It builds
 * the record the Message Decision Engine will read in Phase 5 (brief §24).
 */
@Injectable()
@Processor(QUEUES.MESSAGE_INCOMING)
export class InboundProcessor extends WorkerHost {
  private readonly logger = new AppLogger(InboundProcessor.name);

  constructor(
    @InjectRepository(ProviderEvent) private readonly events: Repository<ProviderEvent>,
    @InjectRepository(ChannelAccount) private readonly accounts: Repository<ChannelAccount>,
    private readonly registry: ChannelRegistryService,
    private readonly inboundMessages: InboundMessageService,
    private readonly delivery: DeliveryService,
    private readonly channelAccounts: ChannelAccountService,
    private readonly realtime: RealtimeGateway,
    private readonly locks: LockService,
    private readonly metrics: MetricsService,
    @InjectRepository(Conversation) private readonly conversations: Repository<Conversation>,
    private readonly decisions: DecisionService,
    @Optional()private readonly presentation?:MessagePresentationService,
    @Optional()private readonly labels?:ChannelLabelService,
  ) {
    super();
  }

  async process(job: Job<{ providerEventId: string; channelAccountId: string; eventType: string }>): Promise<void> {
    const { providerEventId } = job.data;

    const event = await this.events.findOne({ where: { id: providerEventId } });
    if (!event) {
      // The retention sweep never deletes rows, so a missing one means the account was removed.
      this.logger.warn('Provider event no longer exists', { providerEventId });
      return;
    }
    if (event.status === ProviderEventStatus.PROCESSED) {
      // At-least-once delivery: a redelivered job for an already-processed event is normal.
      this.metrics.increment('inbound.job_duplicate');
      return;
    }

    // Queue latency: how long the event waited between acknowledgement and processing (brief §18).
    this.metrics.observeDuration('inbound.queue_latency_ms', Date.now() - event.createdAt.getTime());

    const account = await this.accounts.findOne({ where: { id: event.channelAccountId } });
    if (!account) {
      await this.finish(event, ProviderEventStatus.IGNORED, 'Channel account no longer exists');
      return;
    }

    try {
      await this.metrics.time('inbound.process_ms', () => this.dispatch(event, account), {
        eventType: event.eventType,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Recorded on the row, then rethrown so BullMQ's backoff gets its chance. The row is the
      // durable evidence; the queue is only the retry mechanism.
      await this.events.update(event.id, {
        status: ProviderEventStatus.FAILED,
        error: message.slice(0, 2000),
      });
      this.metrics.increment('inbound.failed', { eventType: event.eventType });
      throw error;
    }
  }

  private async dispatch(event: ProviderEvent, account: ChannelAccount): Promise<void> {
    const envelope = event.rawPayload as
      | { event: string; data: Record<string, unknown>; sessionId: string; timestamp: string }
      | null;

    if (!envelope) {
      // The retention sweep cleared the payload before the job ran — only possible for an event
      // that sat unprocessed for days. Nothing to reconstruct; record it honestly.
      await this.finish(event, ProviderEventStatus.IGNORED, 'Raw payload was purged before processing');
      return;
    }

    switch (event.eventType) {
      case 'message.received':
      case 'message.sent':
        await this.handleMessage(event, account, envelope);
        return;

      case 'channel.label':
        await this.labels?.apply(account.id,envelope.data as unknown as NormalizedChannelLabel);await this.finish(event,ProviderEventStatus.PROCESSED);return;
      case 'chat_presence':
        this.realtime.emitWhatsAppEvent('whatsapp.chat.presence',{channelAccountId:account.id,...envelope.data});await this.finish(event,ProviderEventStatus.PROCESSED);return;

      case 'message.ack':
        await this.handleAck(event, account, envelope.data);
        return;

      case 'session.status':
      case 'session.authenticated':
      case 'session.disconnected':
      case 'session.qr':
        await this.handleSessionEvent(event, account, envelope);
        return;

      case 'group.join':
      case 'group.leave':
      case 'group.update':
        // Group membership is authoritative from a sync, not from an event — a join event carries
        // no participant list, and inferring one would diverge from reality. Recorded here so the
        // Phase 3 UI can prompt a resync; the sync job remains the source of truth.
        this.realtime.emitWhatsAppEvent('whatsapp.group.updated', {
          channelAccountId: account.id,
          eventType: event.eventType,
        });
        await this.finish(event, ProviderEventStatus.PROCESSED);
        return;

      case 'message.revoked':case 'message.edited':case 'message.deleted':case 'message.reaction': {
        const change=this.registry.get(account.channelKey as ChannelKey).normalizeMessageMutation?.(event.eventType,envelope.data);
        if(change)await this.presentation?.apply(account.id,change);
        await this.finish(event,ProviderEventStatus.PROCESSED);return;
      }

      default:
        await this.finish(event, ProviderEventStatus.IGNORED, `Unhandled event type ${event.eventType}`);
    }
  }

  private async handleMessage(
    event: ProviderEvent,
    account: ChannelAccount,
    envelope: { data: Record<string, unknown> },
  ): Promise<void> {
    const normalized = this.registry
      .get(account.channelKey as ChannelKey)
      .normalizeInboundMessage(account, envelope);
    const mutation=this.registry.get(account.channelKey as ChannelKey).normalizeMessageMutation?.(event.eventType,envelope.data);if(mutation)await this.presentation?.apply(account.id,mutation);
    if (!normalized) {
      // A status broadcast or an unaddressable payload. Normal, not an error.
      await this.finish(event, ProviderEventStatus.IGNORED, 'Not a conversation message');
      return;
    }

    // Per-conversation lock: `PROJECT_SPEC.md` §186–187. Two workers processing the same
    // conversation could interleave, and message 2 could be persisted before message 1 has resolved
    // its quoted reference. `onBusy: 'wait'` rather than 'skip' — unlike a reply decision, a
    // persist must not be dropped just because a sibling event holds the lock.
    const lockName = `conversation:${account.id}:${normalized.externalConversationId}`;

    const result = await this.locks.withLock(
      lockName,
      CONVERSATION_LOCK_TTL_MS,
      () => this.inboundMessages.persist(account, normalized, event.id),
      { onBusy: 'wait', waitTimeoutMs: 20_000 },
    );

    if (result === null) {
      // Could not obtain the lock in time. Throwing hands it back to BullMQ's backoff rather than
      // silently dropping a customer message.
      throw new Error(`Timed out waiting for the conversation lock on ${lockName}`);
    }

    if (result.duplicate) {
      await this.finish(event, ProviderEventStatus.PROCESSED, 'Duplicate message, already persisted');
      return;
    }

    const message = result.message!;
    await this.inboundMessages.markProcessed(message.id, MessageProcessingStatus.PROCESSED);
    await this.events.update(event.id, {
      status: ProviderEventStatus.PROCESSED,
      messageId: message.id,
      processedAt: new Date(),
    });

    /*
     * The Message Decision Engine (Phase 5).
     *
     * Called here and nowhere else: this is the single point at which an inbound message becomes a
     * decision. The message is already durable, and the per-conversation lock this method holds is
     * still held — so one decision per conversation at a time falls out of the existing mutual
     * exclusion rather than needing a second one.
     *
     * Deliberately AFTER persistence and deliberately non-fatal. A decision failure must never undo
     * a stored customer message; the decision service turns every failure into a recorded FAILED
     * decision plus an escalation, so a person looks at it rather than the customer being ignored.
     */
    if (ENGINE_CLASSIFICATIONS.includes(message.classification) && message.conversationId) {
      const conversation = await this.conversations.findOne({ where: { id: message.conversationId } });
      if (conversation) {
        await this.decisions
          .handleInbound(message, conversation)
          .catch((error: Error) =>
            this.logger.error('The decision pipeline failed after persisting the message', {
              messageId: message.id,
              error: error.message,
            }),
          );
      }
    }

    this.realtime.emitWhatsAppEvent('whatsapp.message.received', {
      channelAccountId: account.id,
      messageId: message.id,
      externalConversationId: message.externalConversationId,
      externalGroupId: message.externalGroupId,
      classification: message.classification,
      contentType: message.contentType,
      direction: message.direction,
      sentAt: message.sentAt,
      // Deliberately no body: the realtime channel fans out to every subscribed admin socket, and
      // message content belongs behind an authorised fetch, not a broadcast (PROJECT_SPEC.md §110).
    });
  }

  private async handleAck(
    event: ProviderEvent,
    account: ChannelAccount,
    data: Record<string, unknown>,
  ): Promise<void> {
    // The adapter interprets the provider's payload; this method never sees its shape.
    const adapter=this.registry.get(account.channelKey as ChannelKey);
    const single=adapter.normalizeDeliveryReceipt(event.eventType,data);
    const receipts=adapter.normalizeDeliveryReceipts?.(event.eventType,data)??(single?[single]:[]);

    if (!receipts.length) {
      await this.finish(event, ProviderEventStatus.IGNORED, 'Unmappable delivery receipt');
      return;
    }

    for(const receipt of receipts)await this.delivery.applyReceipt(account.id, receipt.externalMessageId, receipt.status);
    await this.finish(event, ProviderEventStatus.PROCESSED);
  }

  private async handleSessionEvent(
    event: ProviderEvent,
    account: ChannelAccount,
    envelope: { event: string; data: Record<string, unknown> },
  ): Promise<void> {
    const adapter = this.registry.get(account.channelKey as ChannelKey);

    // The adapter maps the provider's session vocabulary and strips anything sensitive — notably
    // the `session.qr` payload, which never reaches this normalized shape.
    const connection = adapter.normalizeConnectionEvent(envelope.event, envelope.data ?? {});

    if (!connection) {
      await this.finish(event, ProviderEventStatus.IGNORED, 'Unmappable session event');
      return;
    }

    const previousState = account.status as ChannelConnectionState;

    await this.channelAccounts.recordState(account, connection.state, {
      source: ConnectionEventSource.GATEWAY_EVENT,
      rawState: connection.rawState,
      detail: connection.detail,
    });

    // The QR is fetched through a SEPARATE adapter method and delivered to a permission-gated room,
    // never to the channel firehose. It is not persisted here and not written to `provider_events`
    // beyond the bounded raw-payload retention the ingestion layer already applies.
    const pairing = adapter.extractPairingPayload(envelope.event, envelope.data ?? {});
    if (pairing) {
      this.realtime.emitPairingPayload(account.id, pairing.payload, pairing.expiresAt, pairing.format);
      this.metrics.increment('channel.qr_delivered');
    }

    // Pairing succeeded: close the QR room so no stale code lingers in a connected client, and
    // announce the transition the UI is waiting on.
    if (
      connection.state === ChannelConnectionState.CONNECTED &&
      previousState !== ChannelConnectionState.CONNECTED
    ) {
      this.realtime.closePairingRoom(account.id);
      this.realtime.emitWhatsAppEvent('whatsapp.account.connected', {
        channelAccountId: account.id,
        channelKey: account.channelKey,
      });
    }

    await this.finish(event, ProviderEventStatus.PROCESSED);
  }

  private async finish(
    event: ProviderEvent,
    status: ProviderEventStatus,
    note?: string,
  ): Promise<void> {
    await this.events.update(event.id, {
      status,
      processedAt: new Date(),
      ...(note ? { error: note.slice(0, 2000) } : {}),
    });
    this.metrics.increment('inbound.processed', { eventType: event.eventType, status });
  }
}
