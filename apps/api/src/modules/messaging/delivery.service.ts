import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppLogger } from '../../common/logging/app-logger';
import { MetricsService } from '../../common/metrics/metrics.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { Message } from './entities/message.entity';
import { OutboundMessage } from './entities/outbound-message.entity';
import { DeliveryStatus, isDeliveryProgression } from './message-types';

/**
 * Applies delivery receipts to outbound messages (Phase 2 brief §11).
 *
 * The one rule that makes this correct: **receipts are not ordered.** A `delivered` ack can arrive
 * after a `read` ack for the same message, a retry can redeliver an old receipt, and a `sent`
 * confirmation can turn up after the message already failed. Writing whatever arrived last would
 * make the delivery state flap and lie.
 *
 * So every update is gated on `isDeliveryProgression()` — a receipt is applied only if it is
 * genuinely forward progress. Everything else is counted and dropped.
 */
@Injectable()
export class DeliveryService {
  private readonly logger = new AppLogger(DeliveryService.name);

  constructor(
    @InjectRepository(OutboundMessage) private readonly outbound: Repository<OutboundMessage>,
    @InjectRepository(Message) private readonly messages: Repository<Message>,
    private readonly realtime: RealtimeGateway,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Records a receipt for a provider message id.
   *
   * Returns false when nothing changed — an unknown message (a receipt for something a human sent
   * from their phone, which we never queued) or a non-progressing status. Neither is an error.
   */
  async applyReceipt(
    channelAccountId: string,
    externalMessageId: string,
    status: DeliveryStatus,
  ): Promise<boolean> {
    const row = await this.outbound.findOne({
      where: { channelAccountId, externalMessageId },
    });

    if (!row) {
      // Entirely expected: the account also sends messages we did not originate.
      this.metrics.increment('delivery.receipt_unmatched');
      return false;
    }

    if (!isDeliveryProgression(row.status, status)) {
      this.metrics.increment('delivery.receipt_ignored', { from: row.status, to: status });
      return false;
    }

    await this.outbound.update(row.id, {
      status,
      ...(status === DeliveryStatus.FAILED
        ? { failureReason: 'The channel reported delivery failure' }
        : {}),
    });

    // Keep the message log in step so the inbox can render a tick without a second query.
    if (row.messageId) {
      await this.messages.update(row.messageId, { deliveryStatus: status }).catch(() => undefined);
    }

    this.metrics.increment('delivery.updated', { status });
    this.realtime.emitWhatsAppEvent('whatsapp.message.delivery_updated', {
      channelAccountId,
      outboundMessageId: row.id,
      externalMessageId,
      status,
    });

    this.logger.debug('Delivery status updated', {
      outboundMessageId: row.id,
      from: row.status,
      to: status,
    });
    return true;
  }

  /**
   * Fails messages that were handed to the gateway but never acknowledged.
   *
   * Without this a crashed worker can leave a row in SENDING forever: BullMQ considers the job
   * delivered, so nothing retries it, and no receipt is coming. Run periodically by the maintenance
   * queue (brief §14).
   *
   * `SENDING` is the only state swept. `QUEUED` rows are safe — their job is still in Redis — and
   * `SENT` is a legitimate terminal state for a channel that reports no further receipts.
   */
  async reconcileStalledSends(olderThanMs = 10 * 60 * 1000): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);

    const stalled = await this.outbound
      .createQueryBuilder('om')
      .where('om.status = :status', { status: DeliveryStatus.SENDING })
      .andWhere('om.lastAttemptAt < :cutoff', { cutoff })
      .limit(500)
      .getMany();

    for (const row of stalled) {
      await this.outbound.update(row.id, {
        status: DeliveryStatus.FAILED,
        failureReason:
          'No delivery confirmation was received from the channel within the reconciliation window. ' +
          'The message may or may not have been delivered.',
      });
      this.metrics.increment('delivery.stalled_failed');
    }

    if (stalled.length > 0) {
      // Worth a warning, not a debug line: this means messages of uncertain fate.
      this.logger.warn('Marked stalled outbound messages as failed', { count: stalled.length });
    }
    return stalled.length;
  }
}
