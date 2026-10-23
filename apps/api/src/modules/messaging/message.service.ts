import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { AppLogger } from '../../common/logging/app-logger';
import { MetricsService } from '../../common/metrics/metrics.service';
import { normalizeCapabilities } from '../channel/channel-capabilities';
import { ChannelConnectionState, canSendInState } from '../channel/channel-connection';
import { ChannelAccount } from '../channel/entities/channel-account.entity';
import { ChannelKey } from '../channel/entities/channel.entity';
import { QUEUES } from '../jobs/queues';
import { EMERGENCY_STOPS, SettingsService } from '../settings/settings.service';
import { OutboundMessage, OutboundSource } from './entities/outbound-message.entity';
import { DeliveryStatus, MessageContentType } from './message-types';

/** Mirrors the adapter's persist cap so an oversized body is refused before it reaches the queue. */
const MAX_OUTBOUND_BODY = 16_000;

export interface SendMessageInput {
  channelCommand?:import('../channel/channel-adapter.interface').ChannelCommand;
  contentType?:MessageContentType;
  scheduledFor?:Date;
  managedScheduleId?:string;
  channelAccountId: string;
  externalConversationId: string;
  body: string;
  quotedExternalId?: string | null;
  attachments?: Array<{ mimeType: string; filename: string; storageRef: string; caption?: string }>;
  idempotencyKey?: string | null;
  source?: OutboundSource;
  createdById?: string | null;
  /**
   * The decision that caused this send.
   *
   * Required for AUTOMATION and AI. That requirement is what makes "no automatic response bypasses
   * the Decision Engine" enforceable rather than aspirational: a future feature that tries to
   * auto-reply without going through the engine has no decision id to supply, and fails here
   * (PROJECT_SPEC.md §5, §161).
   */
  decisionId?: string | null;
  broadcastId?: string | null;
}

/**
 * **The single outbound control point** (Phase 2 brief §10, §12; `PROJECT_SPEC.md` §56, §161).
 *
 * Every message Support CRM will ever send — a human reply today, and automation, AI and broadcast
 * later — enters here and nowhere else. There is no other route to a channel adapter: the adapter's
 * `send()` is called by exactly one consumer, the outbound worker, which only ever processes rows
 * this service created.
 *
 * That is the entire point of the design. The checks this method performs today are modest
 * (ownership, emergency stop, connection state, capability, size); the ones that matter most are
 * still to come — conversation state, human takeover, AI cooldown, rate limits, duplicate
 * suppression. Because there is one choke point, each of those becomes a few lines here rather than
 * an audit of every caller in the codebase.
 *
 * `send()` never talks to the gateway. It validates, persists, and enqueues. A slow WhatsApp
 * operation must never block an HTTP request (brief §10).
 */
@Injectable()
export class MessageService {
  private readonly logger = new AppLogger(MessageService.name);

  constructor(
    @InjectRepository(OutboundMessage) private readonly outbound: Repository<OutboundMessage>,
    @InjectRepository(ChannelAccount) private readonly accounts: Repository<ChannelAccount>,
    @InjectQueue(QUEUES.MESSAGE_OUTGOING) private readonly queue: Queue,
    private readonly settings: SettingsService,
    private readonly metrics: MetricsService,
  ) {}

  async send(input: SendMessageInput): Promise<OutboundMessage> {
    const body = (input.body ?? '').trim();
    if (!body && !input.attachments?.length&&!input.channelCommand) {
      throw new BadRequestException('A message must have a body or at least one attachment');
    }
    if (body.length > MAX_OUTBOUND_BODY) {
      throw new BadRequestException(`Message body exceeds ${MAX_OUTBOUND_BODY} characters`);
    }

    // Idempotency BEFORE any other work: a retried request must return the original row rather than
    // re-run the checks and risk a second send (`PROJECT_SPEC.md` §117, §192).
    if (input.idempotencyKey) {
      const existing = await this.outbound.findOne({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) {
        this.metrics.increment('outbound.idempotent_hit');
        if(existing.status===DeliveryStatus.QUEUED)await this.enqueue(existing);
        return existing;
      }
    }

    const source = input.source ?? OutboundSource.MANUAL;
    if ((source === OutboundSource.AUTOMATION || source === OutboundSource.AI) && !input.decisionId) {
      throw new BadRequestException(
        'An automatic message must reference the decision that produced it. ' +
          'Every automatic reply goes through the Message Decision Engine.',
      );
    }

    const account = await this.accounts.findOne({ where: { id: input.channelAccountId } });
    if (!account) throw new NotFoundException(`Channel account ${input.channelAccountId} not found`);

    if (!account.ownershipEnabled) {
      throw new ConflictException(
        'This channel account is not owned by Support CRM. Enable ownership before sending.',
      );
    }

    // Emergency stop (`PROJECT_SPEC.md` §37). Checked at enqueue AND again in the worker before the
    // actual send, so a stop engaged while a message sits in the queue still takes effect.
    if (await this.settings.isStopped(EMERGENCY_STOPS.OUTGOING_MESSAGES_STOPPED)) {
      throw new ConflictException(
        'Outgoing messages are stopped by the emergency control. Resume it to send.',
      );
    }

    if (!canSendInState(account.status as ChannelConnectionState)) {
      throw new ConflictException(
        `The WhatsApp account is ${account.status}. It must be CONNECTED before messages can be sent.`,
      );
    }

    // Capability check at enqueue time so the operator hears "this account cannot reply" now,
    // rather than discovering it from a failed row minutes later. The worker checks again before
    // sending, because capabilities can change between the two.
    const capabilities = normalizeCapabilities(account.capabilities);
    if (input.attachments?.length && !capabilities.canSendMedia) {
      throw new ConflictException('This account cannot send media (PROJECT_SPEC.md §174).');
    }
    if (input.quotedExternalId && !capabilities.canReply) {
      throw new ConflictException('This account cannot send replies (PROJECT_SPEC.md §174).');
    }
    if (!input.attachments?.length && !capabilities.canSendText) {
      throw new ConflictException('This account cannot send text messages (PROJECT_SPEC.md §174).');
    }

    let row: OutboundMessage;
    try {
      row = await this.outbound.save(
        this.outbound.create({
          channelKey: account.channelKey as ChannelKey,
          channelAccountId: account.id,
          externalConversationId: input.externalConversationId,
          contentType: input.contentType??(input.attachments?.length ? MessageContentType.DOCUMENT : MessageContentType.TEXT),
          channelCommand:input.channelCommand??null,
          scheduledFor:input.scheduledFor??null,
          managedScheduleId:input.managedScheduleId??null,
          body: body || null,
          quotedExternalId: input.quotedExternalId ?? null,
          attachments: input.attachments?.length
            ? (input.attachments as unknown as Record<string, unknown>[])
            : null,
          idempotencyKey: input.idempotencyKey ?? null,
          status: DeliveryStatus.QUEUED,
          source,
          decisionId: input.decisionId ?? null,
          broadcastId: input.broadcastId ?? null,
          createdById: input.createdById ?? null,
        }),
      );
    } catch (error) {
      // Two replicas raced the idempotency check above. The unique index arbitrated; return the
      // winner rather than surfacing a constraint error to the caller.
      if ((error as { code?: string }).code === '23505' && input.idempotencyKey) {
        const winner = await this.outbound.findOne({ where: { idempotencyKey: input.idempotencyKey } });
        if (winner) {if(winner.status===DeliveryStatus.QUEUED)await this.enqueue(winner);return winner;}
      }
      throw error;
    }

    await this.enqueue(row);

    this.metrics.increment('outbound.queued', { source: row.source });
    this.logger.log('Outbound message queued', {
      outboundMessageId: row.id,
      channelAccountId: account.id,
      source: row.source,
    });
    return row;
  }

  private async enqueue(row:OutboundMessage){
    await this.queue.add(
      'send',
      { outboundMessageId: row.id },
      {
        // Hyphen, not colon — see the note in ingestion.service.ts on BullMQ's job-id rule.
        jobId: `om-${row.id}`,
        delay:Math.max(0,(row.scheduledFor?.getTime()??0)-Date.now()),
        attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 3600, count: 2000 },
        removeOnFail: { age: 24 * 3600 },
      },
    );

  }

  /** Cancels a message that has not been handed to the gateway yet. */
  async cancel(id: string): Promise<OutboundMessage> {
    const row = await this.findOne(id);
    if (row.status !== DeliveryStatus.QUEUED) {
      // Once SENDING or beyond, the gateway may already have it. Reporting a cancellation we cannot
      // guarantee would be worse than refusing (`PROJECT_SPEC.md` §209).
      throw new ConflictException(`Cannot cancel a message that is already ${row.status}`);
    }
    const cancelled=await this.outbound.update({id,status:DeliveryStatus.QUEUED}, {status:DeliveryStatus.CANCELLED,failureReason:'Cancelled before dispatch'});
    if(!cancelled.affected)throw new ConflictException('The message has already been claimed for sending.');
    await this.queue.remove(`om-${id}`).catch(() => undefined);
    return this.findOne(id);
  }

  async findOne(id: string): Promise<OutboundMessage> {
    const row = await this.outbound.findOne({ where: { id } });
    if (!row) throw new NotFoundException(`Outbound message ${id} not found`);
    return row;
  }

  async list(options: {
    channelAccountId?: string;
    status?: DeliveryStatus;
    limit?: number;
    offset?: number;
  }) {
    const limit = Math.min(options.limit ?? 25, 100);
    const offset = Math.max(options.offset ?? 0, 0);

    const [items, total] = await this.outbound.findAndCount({
      where: {
        ...(options.channelAccountId ? { channelAccountId: options.channelAccountId } : {}),
        ...(options.status ? { status: options.status } : {}),
      },
      order: { createdAt: 'DESC' },
      skip: offset,
      take: limit,
    });
    return { items, total, limit, offset };
  }
}
