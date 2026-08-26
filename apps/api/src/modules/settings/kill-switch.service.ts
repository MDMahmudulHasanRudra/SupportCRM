import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppLogger } from '../../common/logging/app-logger';
import { MetricsService } from '../../common/metrics/metrics.service';
import { DeliveryStatus } from '../messaging/message-types';
import { OutboundMessage } from '../messaging/entities/outbound-message.entity';
import { EMERGENCY_STOPS, SettingsService } from './settings.service';

/**
 * The emergency controls (`PROJECT_SPEC.md` §37).
 *
 * Five switches, each doing one thing, because in the moment somebody needs these they should not
 * have to reason about which combination stops what:
 *
 *  * **Pause all AI** — no AI answers; rules still run.
 *  * **Pause all automation** — no rule replies either; everything waits for a person.
 *  * **Stop outgoing messages** — nothing automated leaves the building, including internal
 *    notifications.
 *  * **Disable broadcast** — no campaign may start.
 *  * **Pause bulk operations** — no mass configuration change may be queued.
 *
 * The part that is easy to get wrong: **pending outbound messages are cancelled, not drained**
 * (§37). A switch that only stops *new* sends while a queue of three thousand already-approved
 * messages continues to flow is not an emergency stop. Cancelling them is why this service exists
 * at all rather than the settings API being enough.
 */

export interface KillSwitchState {
  key: string;
  label: string;
  description: string;
  engaged: boolean;
}

const SWITCHES: Array<{ key: string; label: string; description: string }> = [
  {
    key: EMERGENCY_STOPS.ALL_AI_PAUSED,
    label: 'Pause all AI',
    description: 'The AI answers nothing. Deterministic rules keep working; anything they cannot answer goes to a person.',
  },
  {
    key: EMERGENCY_STOPS.ALL_AUTOMATION_PAUSED,
    label: 'Pause all automation',
    description: 'No rule replies and no AI replies. Every incoming message waits for a human.',
  },
  {
    key: EMERGENCY_STOPS.OUTGOING_MESSAGES_STOPPED,
    label: 'Stop automated outgoing messages',
    description: 'Nothing automated leaves the system, and anything already queued is cancelled rather than sent late.',
  },
  {
    key: EMERGENCY_STOPS.BROADCAST_DISABLED,
    label: 'Disable broadcasts',
    description: 'No campaign can be started. A running one must be cancelled on its own screen.',
  },
  {
    key: EMERGENCY_STOPS.BULK_OPERATIONS_PAUSED,
    label: 'Pause bulk operations',
    description: 'No new mass configuration change can be queued.',
  },
];

@Injectable()
export class KillSwitchService {
  private readonly logger = new AppLogger(KillSwitchService.name);

  constructor(
    @InjectRepository(OutboundMessage) private readonly outbound: Repository<OutboundMessage>,
    private readonly settings: SettingsService,
    private readonly metrics: MetricsService,
  ) {}

  async list(): Promise<KillSwitchState[]> {
    const states: KillSwitchState[] = [];
    for (const entry of SWITCHES) {
      states.push({ ...entry, engaged: await this.settings.isStopped(entry.key) });
    }
    return states;
  }

  isKnown(key: string): boolean {
    return SWITCHES.some((entry) => entry.key === key);
  }

  /**
   * Engages or releases one switch.
   *
   * Returns how many queued messages were cancelled, so the confirmation an operator sees can say
   * "stopped, and 412 pending messages cancelled" rather than just "stopped" — the difference
   * between knowing the blast radius and guessing at it.
   */
  async set(key: string, engaged: boolean, userId: string | null): Promise<{ engaged: boolean; cancelled: number }> {
    await this.settings.set(key, engaged, { valueType: 'boolean' as never, category: 'emergency', updatedById: userId ?? undefined });

    let cancelled = 0;
    if (engaged && key === EMERGENCY_STOPS.OUTGOING_MESSAGES_STOPPED) {
      cancelled = await this.cancelPendingOutbound();
    }

    this.metrics.increment('emergency.switch', { key, engaged: String(engaged) });
    this.logger.warn(engaged ? 'Emergency control engaged' : 'Emergency control released', {
      key,
      cancelledOutbound: cancelled,
      userId: userId ?? undefined,
    });

    return { engaged, cancelled };
  }

  /**
   * Cancels everything queued but not yet sent.
   *
   * `QUEUED` only. A message already handed to the gateway has left, and marking it cancelled here
   * would be recording a fiction — §195 is explicit that a status must describe what actually
   * happened.
   */
  private async cancelPendingOutbound(): Promise<number> {
    const result = await this.outbound
      .createQueryBuilder()
      .update(OutboundMessage)
      .set({
        status: DeliveryStatus.CANCELLED,
        failureReason: 'Cancelled by the emergency stop on automated outgoing messages.',
      })
      // QUEUED only. SENDING has already been handed to the gateway, and marking it cancelled
      // here would record a fiction — §195 requires a status to describe what actually happened.
      .where('status = :status', { status: DeliveryStatus.QUEUED })
      .execute();

    return result.affected ?? 0;
  }

  /** How much would be cancelled, for the confirmation dialog — asked before anything happens. */
  async pendingOutboundCount(): Promise<number> {
    return this.outbound.count({
      where: { status: DeliveryStatus.QUEUED },
    });
  }
}
