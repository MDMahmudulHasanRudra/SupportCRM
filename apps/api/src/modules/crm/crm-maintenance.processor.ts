import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { AppLogger } from '../../common/logging/app-logger';
import { QUEUES } from '../jobs/queues';
import { ConversationService } from './conversation.service';

/**
 * Expires human takeovers and pauses whose deadline has passed (Phase 3 brief §7).
 *
 * Piggybacks on the Phase 2 channel-maintenance queue rather than adding a third repeatable job:
 * the sweep already runs every 60 seconds, and a takeover that expires up to a minute late is not a
 * problem worth a second scheduler for.
 *
 * A takeover with no expiry is untouched — that is the deliberate "hold until I release it" case.
 * Only ones that named a deadline are swept, and each is recorded as SYSTEM-attributed in the
 * conversation's history so "it timed out" is distinguishable from "a human released it".
 */
@Injectable()
@Processor(QUEUES.CHANNEL_MAINTENANCE)
export class CrmMaintenanceProcessor extends WorkerHost {
  private readonly logger = new AppLogger(CrmMaintenanceProcessor.name);

  constructor(private readonly conversations: ConversationService) {
    super();
  }

  async process(_job: Job): Promise<void> {
    // Own error boundaries: a failure expiring takeovers must not stop pauses expiring, and neither
    // must stop the channel sweep that shares this queue.
    await this.conversations
      .expireTakeovers()
      .catch((error) =>
        this.logger.warn('Takeover expiry sweep failed', { error: (error as Error).message }),
      );

    await this.conversations
      .expirePauses()
      .catch((error) =>
        this.logger.warn('Pause expiry sweep failed', { error: (error as Error).message }),
      );
  }
}
