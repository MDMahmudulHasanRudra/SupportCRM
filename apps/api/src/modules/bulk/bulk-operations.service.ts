import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AppLogger } from '../../common/logging/app-logger';
import { MetricsService } from '../../common/metrics/metrics.service';
import { AutomationProfile } from '../automation/entities/automation-profile.entity';
import { Group } from '../groups/entities/group.entity';
import { JobType } from '../jobs/entities/job.entity';
import { JobsService } from '../jobs/jobs.service';
import { EMERGENCY_STOPS, SettingsService } from '../settings/settings.service';

/**
 * Bulk configuration across thousands of groups (`PROJECT_SPEC.md` §47–§49; brief §26).
 *
 * The specification targets 3,000+ groups. Two consequences shape this service:
 *
 *  1. **Nothing happens inside the HTTP request.** A request that writes three thousand rows holds
 *     a worker for the duration and cannot report progress, retry a failure or be cancelled. This
 *     builds a Job Center job with one item per group and returns the job id (§49).
 *  2. **One item per group.** Progress is real, a failure is attributable, and "retry failed"
 *     re-runs exactly the groups that did not work — not the whole batch.
 */

export enum BulkOperation {
  ENABLE_AUTOMATION = 'ENABLE_AUTOMATION',
  DISABLE_AUTOMATION = 'DISABLE_AUTOMATION',
  ENABLE_AI = 'ENABLE_AI',
  DISABLE_AI = 'DISABLE_AI',
  ENABLE_MONITORING = 'ENABLE_MONITORING',
  DISABLE_MONITORING = 'DISABLE_MONITORING',
  ASSIGN_AUTOMATION_PROFILE = 'ASSIGN_AUTOMATION_PROFILE',
  ASSIGN_KNOWLEDGE_PROFILE = 'ASSIGN_KNOWLEDGE_PROFILE',
  CLEAR_AUTOMATION_PROFILE = 'CLEAR_AUTOMATION_PROFILE',
}

export interface BulkRequest {
  operation: BulkOperation;
  /** Explicit ids, or a filter. One or the other — never "everything" by accident. */
  groupIds?: string[];
  filter?: { channelAccountId?: string; monitoringState?: string };
  targetId?: string;
}

/** A ceiling on one job. Beyond this, an operator should be filtering rather than selecting. */
const MAX_ITEMS = 10_000;

@Injectable()
export class BulkOperationsService {
  private readonly logger = new AppLogger(BulkOperationsService.name);

  constructor(
    @InjectRepository(Group) private readonly groups: Repository<Group>,
    @InjectRepository(AutomationProfile) private readonly profiles: Repository<AutomationProfile>,
    private readonly jobs: JobsService,
    private readonly settings: SettingsService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Resolves the target set and queues the work.
   *
   * Resolving happens now rather than in the worker so the operator is told how many groups they
   * are about to change *before* it starts, and so the set cannot drift between the click and the
   * execution.
   */
  async queue(request: BulkRequest, userId: string | null) {
    if (await this.settings.isStopped(EMERGENCY_STOPS.BULK_OPERATIONS_PAUSED)) {
      throw new BadRequestException('Bulk operations are paused by the emergency control.');
    }

    if (request.operation === BulkOperation.ASSIGN_AUTOMATION_PROFILE) {
      if (!request.targetId) throw new BadRequestException('Assigning a profile needs a profile id.');
      const exists = await this.profiles.exist({ where: { id: request.targetId } });
      if (!exists) throw new BadRequestException('That automation profile does not exist.');
    }

    const groups = await this.resolveTargets(request);
    if (groups.length === 0) throw new BadRequestException('That selection matched no groups.');
    if (groups.length > MAX_ITEMS) {
      throw new BadRequestException(
        `That selection covers ${groups.length} groups, more than the ${MAX_ITEMS} allowed in one operation.`,
      );
    }

    const job = await this.jobs.create({
      type: JobType.BULK_GROUP_UPDATE,
      name: `${humanise(request.operation)} — ${groups.length} group${groups.length === 1 ? '' : 's'}`,
      payload: { operation: request.operation, targetId: request.targetId ?? null },
      items: groups.map((group) => ({
        reference: group.id,
        payload: { groupId: group.id, operation: request.operation, targetId: request.targetId ?? null },
      })),
      createdById: userId,
    });

    this.metrics.increment('bulk.queued', { operation: request.operation }, groups.length);
    this.logger.log('Bulk group operation queued', {
      jobId: job.id,
      operation: request.operation,
      groups: groups.length,
    });

    return { jobId: job.id, totalItems: groups.length, operation: request.operation };
  }

  /** Tells an operator what a selection covers, before they commit to it. */
  async preview(request: BulkRequest) {
    const groups = await this.resolveTargets(request);
    return {
      total: groups.length,
      sample: groups.slice(0, 10).map((group) => ({ id: group.id, name: group.name })),
    };
  }

  /**
   * Applies one operation to one group. Called by the Job Center handler, once per item.
   *
   * Idempotent by nature: every operation is a set-to-a-value, so re-running an item after a retry
   * produces the same row rather than compounding.
   */
  async applyToGroup(groupId: string, operation: BulkOperation, targetId: string | null): Promise<void> {
    const patch: Record<string, unknown> = {};

    switch (operation) {
      case BulkOperation.ENABLE_AUTOMATION:
        patch.automationEnabled = true;
        break;
      case BulkOperation.DISABLE_AUTOMATION:
        patch.automationEnabled = false;
        break;
      case BulkOperation.ENABLE_AI:
        patch.aiEnabled = true;
        break;
      case BulkOperation.DISABLE_AI:
        patch.aiEnabled = false;
        break;
      case BulkOperation.ENABLE_MONITORING:
        patch.monitoringState = 'MONITORED';
        break;
      case BulkOperation.DISABLE_MONITORING:
        patch.monitoringState = 'IGNORED';
        break;
      case BulkOperation.ASSIGN_AUTOMATION_PROFILE:
        patch.automationProfileId = targetId;
        break;
      case BulkOperation.CLEAR_AUTOMATION_PROFILE:
        patch.automationProfileId = null;
        break;
      case BulkOperation.ASSIGN_KNOWLEDGE_PROFILE:
        patch.knowledgeProfileId = targetId;
        break;
      default:
        throw new Error(`Unknown bulk operation ${operation}`);
    }

    await this.groups.update(groupId, patch);
  }

  private async resolveTargets(request: BulkRequest): Promise<Group[]> {
    if (request.groupIds?.length) {
      return this.groups.find({ where: { id: In(request.groupIds) }, select: { id: true, name: true } });
    }

    if (!request.filter || Object.keys(request.filter).length === 0) {
      // Refusing an empty filter is the point: "apply to everything" should be something somebody
      // asks for explicitly, by listing ids or naming an account.
      throw new BadRequestException('Select groups, or give a filter. A bulk change needs a target.');
    }

    return this.groups.find({
      where: {
        isActive: true,
        ...(request.filter.channelAccountId ? { channelAccountId: request.filter.channelAccountId } : {}),
        ...(request.filter.monitoringState
          ? { monitoringState: request.filter.monitoringState as never }
          : {}),
      },
      select: { id: true, name: true },
      take: MAX_ITEMS + 1,
    });
  }
}

function humanise(operation: BulkOperation): string {
  return operation.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
