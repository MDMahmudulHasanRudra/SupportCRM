import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelAccount } from '../channel/entities/channel-account.entity';
import type { Job } from '../jobs/entities/job.entity';
import type { JobItem } from '../jobs/entities/job-item.entity';
import { JobProcessor, type JobItemHandler } from '../jobs/job.processor';
import { JobType } from '../jobs/entities/job.entity';
import { GroupSyncService } from './group-sync.service';

/**
 * Job Center handler for `CHANNEL_PARTICIPANT_SYNC` — one item per group.
 *
 * Registering here rather than inside `JobProcessor` keeps the Job Center generic: it knows how to
 * walk items, lock a job and record per-item outcomes, and nothing about groups or channels
 * (`PROJECT_SPEC.md` §158).
 *
 * A thrown error marks only this group's item FAILED; the other 2,999 continue, and "retry failed"
 * re-runs exactly the ones that did not work.
 */
@Injectable()
export class ParticipantSyncHandler implements JobItemHandler, OnModuleInit {
  constructor(
    private readonly processor: JobProcessor,
    private readonly sync: GroupSyncService,
    @InjectRepository(ChannelAccount) private readonly accounts: Repository<ChannelAccount>,
  ) {}

  onModuleInit(): void {
    this.processor.registerHandler(JobType.CHANNEL_PARTICIPANT_SYNC, this);
  }

  async handle(item: JobItem, job: Job): Promise<Record<string, unknown>> {
    const payload = (item.payload ?? {}) as { groupId?: string; channelAccountId?: string };
    const channelAccountId =
      payload.channelAccountId ?? (job.payload as { channelAccountId?: string } | null)?.channelAccountId;

    if (!payload.groupId || !channelAccountId) {
      throw new Error('Participant sync item is missing groupId or channelAccountId');
    }

    const account = await this.accounts.findOne({ where: { id: channelAccountId } });
    if (!account) throw new Error(`Channel account ${channelAccountId} no longer exists`);

    // Ownership is re-checked per item, not once per job: a job over thousands of groups runs for
    // minutes, and an operator revoking ownership mid-run must take effect immediately.
    if (!account.ownershipEnabled) {
      throw new Error('Support CRM no longer owns this channel account');
    }

    const result = await this.sync.syncParticipants(account, payload.groupId, item.reference);
    return { active: result.active, deactivated: result.deactivated };
  }
}
