import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import { ChannelAccountService } from '../channel/channel-account.service';
import { CurrentUser, RequirePermissions } from '../rbac/permissions.guard';
import { GroupParticipant } from './entities/group-participant.entity';
import { Group, GroupMonitoringState } from './entities/group.entity';
import { GroupSyncService } from './group-sync.service';

export class ListGroupsDto {
  @IsOptional() @IsUUID() channelAccountId?: string;
  @IsOptional() @IsEnum(GroupMonitoringState) monitoringState?: GroupMonitoringState;
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @Type(() => Boolean) @IsBoolean() includeInactive?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

export class UpdateGroupConfigDto {
  @IsOptional() @IsEnum(GroupMonitoringState) monitoringState?: GroupMonitoringState;
  @IsOptional() @IsBoolean() aiEnabled?: boolean;
  @IsOptional() @IsBoolean() automationEnabled?: boolean;
}

export class ListParticipantsDto {
  @IsOptional() @Type(() => Boolean) @IsBoolean() includeInactive?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

@ApiTags('groups')
@Controller('groups')
export class GroupsController {
  constructor(
    @InjectRepository(Group) private readonly groups: Repository<Group>,
    @InjectRepository(GroupParticipant) private readonly participants: Repository<GroupParticipant>,
    private readonly sync: GroupSyncService,
    private readonly accounts: ChannelAccountService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Always paginated, never "all groups".
   *
   * `PROJECT_SPEC.md` §103 forbids loading thousands of records into a browser, and this endpoint is
   * the one most likely to be asked for all 3,000 at once. Search uses the trigram index rather
   * than a sequential scan.
   */
  @Get()
  @RequirePermissions('groups.read')
  @ApiOperation({ summary: 'List groups (paginated, searchable)' })
  async list(@Query() query: ListGroupsDto) {
    const limit = Math.min(query.limit ?? 50, 200);
    const offset = Math.max(query.offset ?? 0, 0);

    const qb = this.groups.createQueryBuilder('g').orderBy('g.lastMessageAt', 'DESC', 'NULLS LAST');
    if (query.channelAccountId) {
      qb.andWhere('g.channelAccountId = :accountId', { accountId: query.channelAccountId });
    }
    if (query.monitoringState) {
      qb.andWhere('g.monitoringState = :state', { state: query.monitoringState });
    }
    if (!query.includeInactive) qb.andWhere('g.isActive = true');
    if (query.search) {
      // Parameterised — a group name is untrusted input and must never be concatenated into SQL.
      qb.andWhere('g.name ILIKE :search', { search: `%${query.search}%` });
    }

    const [items, total] = await qb.skip(offset).take(limit).getManyAndCount();
    return { items: items.map(serializeGroup), total, limit, offset };
  }

  @Get(':id')
  @RequirePermissions('groups.read')
  @ApiOperation({ summary: 'One group with its configuration and sync timestamps' })
  async findOne(@Param('id') id: string) {
    const group = await this.groups.findOne({ where: { id } });
    if (!group) throw new NotFoundException(`Group ${id} not found`);

    const activeParticipants = await this.participants.count({ where: { groupId: id, isActive: true } });
    return { ...serializeGroup(group), activeParticipants };
  }

  @Get(':id/participants')
  @RequirePermissions('groups.read')
  @ApiOperation({ summary: 'Group participants (paginated)' })
  async listParticipants(@Param('id') id: string, @Query() query: ListParticipantsDto) {
    const group = await this.groups.findOne({ where: { id }, select: { id: true } });
    if (!group) throw new NotFoundException(`Group ${id} not found`);

    const limit = Math.min(query.limit ?? 100, 500);
    const offset = Math.max(query.offset ?? 0, 0);

    const [items, total] = await this.participants.findAndCount({
      where: { groupId: id, ...(query.includeInactive ? {} : { isActive: true }) },
      order: { role: 'ASC', displayName: 'ASC' },
      skip: offset,
      take: limit,
    });

    return { items, total, limit, offset };
  }

  /**
   * Triggers a group-list sync for one account.
   *
   * Runs inline because it is a single paginated walk of a cheap endpoint — bounded work, seconds
   * even at thousands of groups. Participants are the expensive part and go to the Job Center.
   */
  @Post('sync')
  @RequirePermissions('groups.update')
  @ApiOperation({ summary: 'Synchronize the group list for a channel account' })
  async syncGroups(
    @Body() body: { channelAccountId?: string },
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    if (!body?.channelAccountId) throw new BadRequestException('channelAccountId is required');

    const account = await this.accounts.findOne(body.channelAccountId);
    if (!account.ownershipEnabled) {
      throw new ConflictException('Support CRM does not own this account. Enable ownership first.');
    }

    // Locked: two concurrent syncs would race on the same upserts and could deactivate a group one
    // of them had just seen.
    const result = await this.accounts.withSessionLock(account.id, 'group sync', () =>
      this.sync.syncGroups(account),
    );

    await this.audit.record(
      {
        action: 'groups.sync',
        resource: 'channel_account',
        resourceId: account.id,
        after: result as unknown as Record<string, unknown>,
      },
      this.audit.actorFromRequest(request, user),
    );

    return result;
  }

  /**
   * Queues a participant sync as a Job Center job — one item per group.
   *
   * Never inline: at 3,000 groups this is 3,000 gateway calls, which `PROJECT_SPEC.md` §49 forbids
   * running inside a request. The response is a job id to watch.
   */
  @Post('sync-participants')
  @RequirePermissions('groups.update')
  @ApiOperation({ summary: 'Queue a participant sync (one Job Center item per group)' })
  async syncParticipants(
    @Body() body: { channelAccountId?: string },
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    if (!body?.channelAccountId) throw new BadRequestException('channelAccountId is required');

    const account = await this.accounts.findOne(body.channelAccountId);
    if (!account.ownershipEnabled) {
      throw new ConflictException('Support CRM does not own this account. Enable ownership first.');
    }

    const job = await this.sync.queueParticipantSync(account, user.id);
    if (!job) {
      throw new ConflictException('No active groups to sync. Run a group sync first.');
    }

    await this.audit.record(
      {
        action: 'groups.sync_participants',
        resource: 'channel_account',
        resourceId: account.id,
        after: { jobId: job.id, totalItems: job.totalItems },
      },
      this.audit.actorFromRequest(request, user),
    );

    return { jobId: job.id, totalItems: job.totalItems, status: job.status };
  }

  /**
   * Synchronizes participants for ONE group.
   *
   * The account-wide endpoint above queues a job per group and is the bulk tool. This is the one an
   * operator reaches for, and it is deliberately the only one the UI offers: pulling every
   * participant of every group is a large, mostly unwanted import of other people's phone numbers,
   * and it should never be a side effect of clicking something on an account.
   *
   * Runs inline — a single gateway call.
   *
   * `channelAccountId` is required rather than inferred. It makes the caller state which account it
   * believes the group belongs to, so a group id from a *different* account is a mismatch this can
   * reject rather than silently honour.
   */
  @Post(':groupId/sync-participants')
  @RequirePermissions('groups.update')
  @ApiOperation({ summary: "Synchronize one group's participants" })
  async syncGroupParticipants(
    @Param('groupId') groupId: string,
    @Body() body: { channelAccountId?: string },
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    if (!body?.channelAccountId) throw new BadRequestException('channelAccountId is required');

    const account = await this.accounts.findOne(body.channelAccountId);
    if (!account.ownershipEnabled) {
      throw new ConflictException('Support CRM does not own this account. Enable ownership first.');
    }

    // Scoped by BOTH ids in one query. A group belonging to another account is reported as absent,
    // not as forbidden: whether some other account owns a group with this id is not something a
    // caller scoped to this account is entitled to learn.
    const group = await this.groups.findOne({
      where: { id: groupId, channelAccountId: account.id },
    });
    if (!group) throw new NotFoundException(`Group ${groupId} not found for this account`);

    // Same lock as every other session-lifecycle operation: two syncs of the same group would race
    // on the same upserts, and one could deactivate a member the other had just seen.
    const result = await this.accounts.withSessionLock(account.id, 'participant sync', () =>
      this.sync.syncParticipants(account, group.id, group.externalId),
    );

    await this.audit.record(
      {
        action: 'groups.sync_participants',
        resource: 'group',
        resourceId: group.id,
        after: { channelAccountId: account.id, ...result },
      },
      this.audit.actorFromRequest(request, user),
    );

    return { groupId: group.id, ...result };
  }

  /**
   * Group monitoring and engine configuration (`PROJECT_SPEC.md` §44, §46).
   *
   * The foundation for `PROJECT_SPEC.md` §47's bulk operations: the flags exist and are auditable
   * now, so Phase 8's bulk endpoints change thousands of these rows rather than inventing the model.
   */
  @Patch(':id/config')
  @RequirePermissions('groups.update')
  @ApiOperation({ summary: 'Update monitoring, AI and automation flags for a group' })
  async updateConfig(
    @Param('id') id: string,
    @Body() dto: UpdateGroupConfigDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const group = await this.groups.findOne({ where: { id } });
    if (!group) throw new NotFoundException(`Group ${id} not found`);

    const before = {
      monitoringState: group.monitoringState,
      aiEnabled: group.aiEnabled,
      automationEnabled: group.automationEnabled,
    };

    await this.groups.update(id, {
      ...(dto.monitoringState !== undefined ? { monitoringState: dto.monitoringState } : {}),
      ...(dto.aiEnabled !== undefined ? { aiEnabled: dto.aiEnabled } : {}),
      ...(dto.automationEnabled !== undefined ? { automationEnabled: dto.automationEnabled } : {}),
    });

    const updated = await this.groups.findOne({ where: { id } });
    await this.audit.record(
      {
        action: 'groups.config_updated',
        resource: 'group',
        resourceId: id,
        before,
        after: {
          monitoringState: updated!.monitoringState,
          aiEnabled: updated!.aiEnabled,
          automationEnabled: updated!.automationEnabled,
        },
      },
      this.audit.actorFromRequest(request, user),
    );

    return serializeGroup(updated!);
  }
}

function serializeGroup(group: Group) {
  return {
    id: group.id,
    channelKey: group.channelKey,
    channelAccountId: group.channelAccountId,
    externalId: group.externalId,
    name: group.name,
    description: group.description,
    participantCount: group.participantCount,
    isActive: group.isActive,
    isAnnounceOnly: group.isAnnounceOnly,
    monitoringState: group.monitoringState,
    aiEnabled: group.aiEnabled,
    automationEnabled: group.automationEnabled,
    lastSyncedAt: group.lastSyncedAt,
    participantsSyncedAt: group.participantsSyncedAt,
    lastMessageAt: group.lastMessageAt,
  };
}
