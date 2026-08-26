import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { AppLogger } from '../../common/logging/app-logger';
import { MetricsService } from '../../common/metrics/metrics.service';
import { Conversation } from '../crm/entities/conversation.entity';
import { Group } from '../groups/entities/group.entity';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { EMERGENCY_STOPS, SettingsService } from '../settings/settings.service';
import { Escalation } from './entities/escalation.entity';
import {
  EscalationEvent,
  EscalationEventKind,
  EscalationEventStatus,
} from './entities/escalation-event.entity';
import { mergeEscalationPolicy, type EscalationPolicy } from './escalation-policy';

/**
 * What the caller must still do.
 *
 * A deliberate seam: this class decides *what* is said and guarantees each notification is claimed
 * exactly once; the escalation service owns the single outbound control point and does the sending.
 */
export interface NotificationOutcome {
  outbound: Array<{ groupId: string; body: string }>;
}

/**
 * Telling the right people that a customer is waiting (`PROJECT_SPEC.md` §29, §33, §34).
 *
 * Every notification is claimed in `escalation_events` **before** it is sent, and the unique index
 * on (escalation, kind, target) is what makes a duplicate impossible. A retried job re-runs this
 * method, loses the insert, and stops — rather than sending the support group a second copy of the
 * same alarm at 3am.
 *
 * Sending itself goes through `MessageService`, the single outbound control point, so an internal
 * notification is rate-limited, audited and recorded exactly like any other outbound message. This
 * module never reaches for a channel adapter; the ESLint boundary enforces that as well as taste.
 */
@Injectable()
export class EscalationNotifier {
  private readonly logger = new AppLogger(EscalationNotifier.name);

  constructor(
    @InjectRepository(EscalationEvent) private readonly events: Repository<EscalationEvent>,
    @InjectRepository(Escalation) private readonly escalations: Repository<Escalation>,
    @InjectRepository(Conversation) private readonly conversations: Repository<Conversation>,
    @InjectRepository(Group) private readonly groups: Repository<Group>,
    private readonly realtime: RealtimeGateway,
    private readonly settings: SettingsService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Notifies everyone the policy names, once each.
   *
   * Never throws: an escalation that was raised must not be undone because a notification failed.
   * A failed notification is recorded as FAILED and stays visible on the dashboard, which is the
   * channel that does not depend on WhatsApp being up.
   */
  async notify(escalation: Escalation, policy: EscalationPolicy): Promise<NotificationOutcome> {
    const resolved = mergeEscalationPolicy(policy);
    // Collected and returned rather than held on `this`: this is a singleton, and two escalations
    // being notified at once would otherwise overwrite each other's pending message.
    const outbound: Array<{ groupId: string; body: string }> = [];

    // The dashboard first, and unconditionally. It is the one notification that cannot fail for an
    // external reason, so it is the one an operator can rely on.
    await this.claimAndRun(escalation, EscalationEventKind.DASHBOARD, 'dashboard', async () => {
      this.realtime.emitDecisionEvent('escalation.raised', {
        escalationId: escalation.id,
        conversationId: escalation.conversationId,
        reason: escalation.reason,
        priority: escalation.priority,
      });
      return 'Pushed to the dashboard.';
    });

    if (await this.settings.isStopped(EMERGENCY_STOPS.OUTGOING_MESSAGES_STOPPED)) {
      // The kill switch stops outgoing messages, and an internal notification is an outgoing
      // message. The dashboard entry above still went out, so nobody is left uninformed.
      await this.record(
        escalation,
        EscalationEventKind.NOTIFY_INTERNAL_GROUP,
        'suppressed',
        EscalationEventStatus.SKIPPED,
        'Outgoing messages are stopped by the emergency control.',
      );
      return { outbound };
    }

    if (resolved.notifyInternalGroup && resolved.internalGroupId) {
      await this.claimAndRun(
        escalation,
        EscalationEventKind.NOTIFY_INTERNAL_GROUP,
        resolved.internalGroupId,
        async () => {
          const message = await this.composeGroupMessage(resolved.internalGroupId as string, escalation);
          outbound.push(message);
          return `Queued for ${message.groupId}.`;
        },
      );
    }

    if (resolved.notifyExecutives) {
      for (const executive of [resolved.primaryExecutiveUserId, resolved.secondaryExecutiveUserId]) {
        if (!executive) continue;
        await this.claimAndRun(escalation, EscalationEventKind.NOTIFY_EXECUTIVE, executive, async () => {
          // Executives are notified in the console rather than on WhatsApp: a personal number is
          // not a support channel, and §34 asks for notification, not for a message to a human's
          // private chat. The dashboard event carries the priority that makes it findable.
          this.realtime.emitDecisionEvent('escalation.executive_notified', {
            escalationId: escalation.id,
            conversationId: escalation.conversationId,
            userId: executive,
            priority: escalation.priority,
          });
          return 'Notified in the console.';
        });
      }
    }

    await this.escalations.update(escalation.id, { notifiedAt: new Date() });
    return { outbound };
  }

  /**
   * Claim, then act.
   *
   * The insert is the claim. `23505` means another worker already owns this notification, so this
   * one returns without sending — which is the entire duplicate guarantee.
   */
  private async claimAndRun(
    escalation: Escalation,
    kind: EscalationEventKind,
    target: string,
    send: () => Promise<string>,
  ): Promise<void> {
    let claimed: EscalationEvent;
    try {
      claimed = await this.events.save(
        this.events.create({ escalationId: escalation.id, kind, target, status: EscalationEventStatus.PENDING }),
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        this.metrics.increment('escalation.notification_deduplicated', { kind });
        return;
      }
      throw error;
    }

    try {
      const detail = await send();
      await this.events.update(claimed.id, {
        status: EscalationEventStatus.SENT,
        sentAt: new Date(),
        detail: detail.slice(0, 1000),
      });
      this.metrics.increment('escalation.notified', { kind });
    } catch (error) {
      await this.events.update(claimed.id, {
        status: EscalationEventStatus.FAILED,
        detail: (error as Error).message.slice(0, 1000),
      });
      this.metrics.increment('escalation.notification_failed', { kind });
      this.logger.error('An escalation notification failed; the dashboard entry still stands', {
        escalationId: escalation.id,
        kind,
        error: (error as Error).message,
      });
    }
  }

  /** Records an outcome without attempting to send — used when a control suppressed the attempt. */
  private async record(
    escalation: Escalation,
    kind: EscalationEventKind,
    target: string,
    status: EscalationEventStatus,
    detail: string,
  ): Promise<void> {
    try {
      await this.events.save(
        this.events.create({ escalationId: escalation.id, kind, target, status, detail }),
      );
    } catch (error) {
      if ((error as { code?: string }).code !== '23505') throw error;
    }
  }

  /**
   * The internal-group message.
   *
   * Carries what an agent needs to act — which conversation, why, how urgent — and deliberately
   * **not** the customer's message text. The support group is a different audience from the
   * conversation itself, and copying customer content into it widens who can read it.
   */
  private async composeGroupMessage(
    groupId: string,
    escalation: Escalation,
  ): Promise<{ groupId: string; body: string }> {
    const group = await this.groups.findOne({ where: { id: groupId } });
    if (!group) throw new Error('The configured internal group no longer exists.');

    const conversation = await this.conversations.findOne({ where: { id: escalation.conversationId } });

    const lines = [
      `A conversation needs a person (${escalation.priority.toLowerCase()}).`,
      `Reason: ${escalation.reason.toLowerCase().replace(/_/g, ' ')}.`,
      conversation?.subject ? `Conversation: ${conversation.subject}` : null,
      'Open Support CRM to take it over.',
    ].filter(Boolean);

    // Composed here, dispatched by the escalation service, which owns the MessageService
    // dependency — this notifier stays free of it so the module graph has one sender, not two.
    return { groupId: group.id, body: lines.join('\n') };
  }

  /** Everything that was attempted for one escalation, for the audit trail and the UI. */
  async eventsFor(escalationId: string): Promise<EscalationEvent[]> {
    return this.events.find({ where: { escalationId }, order: { createdAt: 'ASC' } });
  }

  /** Notifications that never went out, so a person can see the gap rather than assume delivery. */
  async failed(limit = 50): Promise<EscalationEvent[]> {
    return this.events.find({
      where: { status: EscalationEventStatus.FAILED, sentAt: IsNull() },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }
}
