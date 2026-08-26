import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Job } from '../jobs/entities/job.entity';
import { JobType } from '../jobs/entities/job.entity';
import type { JobItem } from '../jobs/entities/job-item.entity';
import { JobProcessor, type JobItemHandler } from '../jobs/job.processor';
import { BulkOperationsService, type BulkOperation } from './bulk-operations.service';

/**
 * Job Center handler for `BULK_GROUP_UPDATE` — one item per group.
 *
 * A failure marks that group's item FAILED and the rest continue, so one bad row in three thousand
 * does not abandon the other 2,999. "Retry failed" then re-runs exactly the ones that did not work.
 */
@Injectable()
export class BulkGroupHandler implements JobItemHandler, OnModuleInit {
  constructor(
    private readonly processor: JobProcessor,
    private readonly bulk: BulkOperationsService,
  ) {}

  onModuleInit(): void {
    this.processor.registerHandler(JobType.BULK_GROUP_UPDATE, this);
  }

  async handle(item: JobItem, job: Job): Promise<Record<string, unknown>> {
    const payload = (item.payload ?? {}) as {
      groupId?: string;
      operation?: BulkOperation;
      targetId?: string | null;
    };
    const jobPayload = (job.payload ?? {}) as { operation?: BulkOperation; targetId?: string | null };

    const operation = payload.operation ?? jobPayload.operation;
    if (!payload.groupId || !operation) {
      throw new Error('Bulk group item is missing a groupId or an operation');
    }

    await this.bulk.applyToGroup(payload.groupId, operation, payload.targetId ?? jobPayload.targetId ?? null);
    return { groupId: payload.groupId, operation };
  }
}
