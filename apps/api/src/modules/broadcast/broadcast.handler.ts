import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Job } from '../jobs/entities/job.entity';
import { JobType } from '../jobs/entities/job.entity';
import type { JobItem } from '../jobs/entities/job-item.entity';
import { JobProcessor, type JobItemHandler } from '../jobs/job.processor';
import { OutboundSource } from '../messaging/entities/outbound-message.entity';
import { BroadcastRecipientStatus } from './entities/broadcast-recipient.entity';
import { MessageService } from '../messaging/message.service';
import { BroadcastService } from './broadcast.service';

/**
 * Job Center handler for `BROADCAST` — one item per recipient.
 *
 * Sends through `MessageService`, which means the existing rate limits, emergency stop and
 * ownership checks all apply. The idempotency key is derived from the campaign and the recipient,
 * so a retried item cannot message somebody twice.
 */
@Injectable()
export class BroadcastHandler implements JobItemHandler, OnModuleInit {
  constructor(
    private readonly processor: JobProcessor,
    private readonly broadcasts: BroadcastService,
    private readonly messages: MessageService,
  ) {}

  onModuleInit(): void {
    this.processor.registerHandler(JobType.BROADCAST, this);
  }

  async handle(item: JobItem, job: Job): Promise<Record<string, unknown>> {
    const payload = (item.payload ?? {}) as { broadcastId?: string; externalConversationId?: string };
    const jobPayload = (job.payload ?? {}) as { channelAccountId?: string; broadcastId?: string };

    const broadcastId = payload.broadcastId ?? jobPayload.broadcastId;
    if (!broadcastId || !payload.externalConversationId || !jobPayload.channelAccountId) {
      throw new Error('Broadcast item is missing its campaign, recipient or account');
    }

    const broadcast = await this.broadcasts.findOne(broadcastId);

    // A retried job item must not produce a second message. The send layer's idempotency key
    // already covers the common case; this covers the one where the row survived but the key's
    // window did not, and it costs one indexed read.
    if (await this.broadcasts.alreadySent(broadcastId, payload.externalConversationId)) {
      return { recipient: payload.externalConversationId, skipped: 'already sent' };
    }

    try {
      const sent = await this.messages.send({
        channelAccountId: jobPayload.channelAccountId,
        externalConversationId: payload.externalConversationId,
        body: broadcast.body,
        source: OutboundSource.BROADCAST,
        broadcastId,
        // Campaign plus recipient: a retried item is the same send, not a second one.
        idempotencyKey: `broadcast:${broadcastId}:${payload.externalConversationId}`,
        createdById: broadcast.createdById,
      });

      await this.broadcasts.recordOutcome(broadcastId, 'success');
      await this.broadcasts.markRecipient(
        broadcastId,
        payload.externalConversationId,
        BroadcastRecipientStatus.SENT,
        { outboundMessageId: sent.id },
      );
      return { outboundId: sent.id, recipient: payload.externalConversationId };
    } catch (error) {
      await this.broadcasts.recordOutcome(broadcastId, 'failure');
      // The reason is recorded against the recipient, so the campaign report can say which twenty
      // of two thousand failed and why — rather than a count with no way to act on it.
      await this.broadcasts.markRecipient(
        broadcastId,
        payload.externalConversationId,
        BroadcastRecipientStatus.FAILED,
        { failureReason: (error as Error).message },
      );
      throw error;
    }
  }
}
