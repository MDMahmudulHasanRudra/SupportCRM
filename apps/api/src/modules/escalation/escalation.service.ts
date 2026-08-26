import { ConflictException, forwardRef, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AppLogger } from '../../common/logging/app-logger';
import { MetricsService } from '../../common/metrics/metrics.service';
import { ConversationControlState, ConversationStatus } from '../crm/conversation-states';
import { Conversation } from '../crm/entities/conversation.entity';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { Escalation, EscalationReason, EscalationStatus } from './entities/escalation.entity';
import { EscalationNotifier } from './escalation-notifier.service';
import { MessageService } from '../messaging/message.service';
import { Group } from '../groups/entities/group.entity';
import { OutboundSource } from '../messaging/entities/outbound-message.entity';
import {
  mergeEscalationPolicy,
  scoreEscalation,
  type EscalationPolicy,
  type EscalationSignals,
} from './escalation-policy';

/**
 * Handing a conversation to a person (`PROJECT_SPEC.md` §20–§26; brief §21–§22).
 *
 * Raising an escalation does four things, and the order matters: the conversation stops being
 * eligible for automatic replies *first*, so there is no window in which a second inbound message
 * could still be answered by a machine while the escalation row is being written.
 *
 * The internal notification never goes to the customer. It is a realtime event to the operators
 * plus a durable row — and it carries a conversation, a group, a reason and a timestamp, never a
 * credential and never the customer's message body.
 */
@Injectable()
export class EscalationService {
  private readonly logger = new AppLogger(EscalationService.name);

  constructor(
    @InjectRepository(Escalation) private readonly escalations: Repository<Escalation>,
    @InjectRepository(Conversation) private readonly conversations: Repository<Conversation>,
    @InjectRepository(Group) private readonly groups: Repository<Group>,
    private readonly realtime: RealtimeGateway,
    private readonly metrics: MetricsService,
    private readonly notifier: EscalationNotifier,
    // Circular by nature: messaging owns the outbound control point, and an internal escalation
    // notice is an outbound message like any other.
    @Inject(forwardRef(() => MessageService)) private readonly messages: MessageService,
  ) {}

  /**
   * Raises an escalation, or returns the one already open.
   *
   * A conversation that escalates on three consecutive messages is one problem, not three items in
   * somebody's queue. The partial unique index enforces that; this catches the collision so a
   * concurrent second decision does not fail the whole pipeline.
   */
  async raise(input: {
    conversationId: string;
    messageId?: string | null;
    decisionId?: string | null;
    reason: EscalationReason | string;
    detail?: string | null;
    confidence?: number | null;
    assignedToTeamId?: string | null;
    /** Signals gathered by the engine, for the priority score (§40). */
    signals?: EscalationSignals;
    /** The merged Global → Profile → Group policy. Decides who gets told (§30, §33, §34). */
    policy?: EscalationPolicy | null;
  }): Promise<Escalation> {
    // Stop automatic responders BEFORE writing the row.
    await this.conversations.update(input.conversationId, {
      status: ConversationStatus.WAITING_FOR_HUMAN,
      controlState: ConversationControlState.HUMAN_ACTIVE,
    });

    const existing = await this.escalations.findOne({
      where: {
        conversationId: input.conversationId,
        status: In([EscalationStatus.OPEN, EscalationStatus.ASSIGNED]),
      },
    });

    if (existing) {
      this.metrics.increment('escalation.deduplicated');
      return existing;
    }

    // Scored before the row is written so the priority is stored with it, not patched on after.
    const policy = mergeEscalationPolicy(input.policy ?? null);
    const verdict = scoreEscalation(
      input.signals ?? signalsFromReason(input.reason as EscalationReason),
      policy.escalationScoreThreshold ?? 5,
    );

    let escalation: Escalation;
    try {
      escalation = await this.escalations.save(
        this.escalations.create({
          conversationId: input.conversationId,
          messageId: input.messageId ?? null,
          decisionId: input.decisionId ?? null,
          reason: (input.reason as EscalationReason) ?? EscalationReason.NO_AUTOMATION_MATCH,
          detail: input.detail?.slice(0, 1_000) ?? null,
          confidence:
            input.confidence === null || input.confidence === undefined ? null : String(input.confidence),
          status: input.assignedToTeamId ? EscalationStatus.ASSIGNED : EscalationStatus.OPEN,
          assignedToTeamId: input.assignedToTeamId ?? null,
          priority: verdict.priority,
          score: verdict.score,
        }),
      );
    } catch (error) {
      // 23505: another worker raised one between the SELECT and the INSERT. Its row is as good as
      // ours would have been.
      if ((error as { code?: string }).code === '23505') {
        const concurrent = await this.escalations.findOne({
          where: {
            conversationId: input.conversationId,
            status: In([EscalationStatus.OPEN, EscalationStatus.ASSIGNED]),
          },
        });
        if (concurrent) return concurrent;
      }
      throw error;
    }

    this.metrics.increment('escalation.raised', { reason: String(input.reason) });
    this.logger.log('Conversation escalated to a human', {
      conversationId: input.conversationId,
      escalationId: escalation.id,
      reason: input.reason,
    });

    // Identifiers and a reason. No message body, no answer text, no credential — this fans out to
    // every subscribed operator socket.
    this.realtime.emitDecisionEvent('decision.escalated', {
      escalationId: escalation.id,
      conversationId: input.conversationId,
      messageId: input.messageId ?? null,
      reason: String(input.reason),
      confidence: input.confidence ?? null,
    });

    // Notification is best-effort and deduplicated in the database. It must never undo the
    // escalation: a customer waiting with nobody told is bad, and a customer not escalated at all
    // because an alert failed is worse.
    try {
      const outcome = await this.notifier.notify(escalation, policy);
      for (const message of outcome.outbound) {
        await this.dispatchInternalNotice(message.groupId, message.body, escalation.id);
      }
    } catch (error) {
      this.logger.error('Escalation notification failed; the escalation itself stands', {
        escalationId: escalation.id,
        error: (error as Error).message,
      });
    }

    return escalation;
  }

  /**
   * Sends one internal notice through the single outbound control point.
   *
   * Not through a channel adapter — this module is forbidden from touching one, and routing it
   * here means an internal alert is rate-limited, recorded and auditable exactly like any other
   * outbound message. `decisionId` is null on purpose: this is not a reply to a customer, so the
   * automation-source guard does not apply and must not be spoofed to look like it does.
   */
  private async dispatchInternalNotice(groupId: string, body: string, escalationId: string): Promise<void> {
    const group = await this.groups.findOne({ where: { id: groupId } });
    if (!group) return;

    await this.messages.send({
      channelAccountId: group.channelAccountId,
      externalConversationId: group.externalId,
      body,
      source: OutboundSource.SYSTEM,
      // Idempotent at the send layer too, so a retry of the surrounding job cannot duplicate the
      // notice even before the escalation_events guard is consulted.
      idempotencyKey: `escalation-notice:${escalationId}`,
    });
  }

  async findOne(id: string): Promise<Escalation> {
    const escalation = await this.escalations.findOne({ where: { id } });
    if (!escalation) throw new NotFoundException(`Escalation ${id} not found`);
    return escalation;
  }

  async list(options: { status?: EscalationStatus; limit?: number; offset?: number } = {}) {
    const [items, total] = await this.escalations.findAndCount({
      where: options.status ? { status: options.status } : {},
      order: { createdAt: 'DESC' },
      take: Math.min(options.limit ?? 50, 200),
      skip: options.offset ?? 0,
    });
    return { items, total };
  }

  async assign(id: string, input: { userId?: string | null; teamId?: string | null }): Promise<Escalation> {
    const escalation = await this.findOne(id);
    if (escalation.status === EscalationStatus.RESOLVED || escalation.status === EscalationStatus.DISMISSED) {
      throw new ConflictException('That escalation is already closed.');
    }

    await this.escalations.update(id, {
      assignedToUserId: input.userId ?? escalation.assignedToUserId,
      assignedToTeamId: input.teamId ?? escalation.assignedToTeamId,
      status: EscalationStatus.ASSIGNED,
    });

    if (input.userId) {
      // Assigning a person is also a takeover: they now own the conversation, and automatic
      // responders must stay down until they release it.
      await this.conversations.update(escalation.conversationId, {
        assignedToUserId: input.userId,
        takeoverByUserId: input.userId,
        takeoverAt: new Date(),
        controlState: ConversationControlState.HUMAN_ACTIVE,
      });
    }

    return this.findOne(id);
  }

  /**
   * Closes an escalation and hands the conversation back.
   *
   * `releaseToAutomation` is deliberate rather than automatic: an agent who resolved a billing
   * question may want the machine answering again, and an agent who de-escalated an angry customer
   * very much may not.
   */
  async resolve(
    id: string,
    input: { userId: string | null; note?: string | null; releaseToAutomation?: boolean; dismiss?: boolean },
  ): Promise<Escalation> {
    const escalation = await this.findOne(id);
    if (escalation.status === EscalationStatus.RESOLVED || escalation.status === EscalationStatus.DISMISSED) {
      throw new ConflictException('That escalation is already closed.');
    }

    await this.escalations.update(id, {
      status: input.dismiss ? EscalationStatus.DISMISSED : EscalationStatus.RESOLVED,
      resolvedById: input.userId,
      resolvedAt: new Date(),
      resolutionNote: input.note?.slice(0, 1_000) ?? null,
    });

    if (input.releaseToAutomation) {
      await this.conversations.update(escalation.conversationId, {
        controlState: ConversationControlState.AUTOMATION_ACTIVE,
        status: ConversationStatus.OPEN,
        takeoverByUserId: null,
        takeoverAt: null,
        takeoverExpiresAt: null,
        takeoverReason: null,
      });
    }

    this.metrics.increment('escalation.resolved');
    this.realtime.emitDecisionEvent('decision.escalation_resolved', {
      escalationId: id,
      conversationId: escalation.conversationId,
      released: input.releaseToAutomation === true,
    });

    return this.findOne(id);
  }

  /**
   * Releases takeovers that have quietly expired.
   *
   * The engine releases an expired takeover when a message arrives. This catches the conversations
   * where no message ever arrives — otherwise a customer who goes quiet leaves the conversation
   * frozen under a person who stopped looking at it days ago.
   */
  async releaseExpiredTakeovers(now = new Date()): Promise<number> {
    const expired = await this.conversations
      .createQueryBuilder('c')
      .where('c."controlState" = :state', { state: ConversationControlState.HUMAN_ACTIVE })
      .andWhere('c."takeoverExpiresAt" IS NOT NULL')
      .andWhere('c."takeoverExpiresAt" <= :now', { now })
      .getMany();

    for (const conversation of expired) {
      await this.conversations.update(conversation.id, {
        controlState: ConversationControlState.AUTOMATION_ACTIVE,
        takeoverByUserId: null,
        takeoverAt: null,
        takeoverExpiresAt: null,
        takeoverReason: null,
      });

      this.realtime.emitDecisionEvent('decision.takeover_expired', { conversationId: conversation.id });
    }

    if (expired.length > 0) {
      this.metrics.increment('decision.takeover_expired', {}, expired.length);
      this.logger.log('Released expired human takeovers', { count: expired.length });
    }

    return expired.length;
  }
}

/**
 * The signals implied by a reason, when the caller supplied none.
 *
 * A fallback rather than the main path: the engine knows far more than the reason code does, and
 * passes real signals. This keeps an escalation raised from elsewhere — a rule action, an operator
 * — from scoring zero and looking trivial.
 */
function signalsFromReason(reason: EscalationReason): EscalationSignals {
  switch (reason) {
    case EscalationReason.CUSTOMER_REQUESTED:
      return { customerAskedForHuman: true };
    case EscalationReason.LOW_CONFIDENCE:
      return { lowConfidence: true };
    case EscalationReason.KNOWLEDGE_INSUFFICIENT:
      return { knowledgeMissing: true };
    case EscalationReason.AI_FAILED:
    case EscalationReason.AI_UNAVAILABLE:
      return { aiFailures: true };
    case EscalationReason.REPEATED_FAILURE:
      return { repeatedComplaint: true, loopDetected: true };
    default:
      return {};
  }
}
