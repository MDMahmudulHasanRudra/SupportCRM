import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermissions } from '../rbac/permissions.guard';
import { ConversationService } from './conversation.service';
import {
  ConversationControlState,
  ConversationKind,
  ConversationPriority,
  ConversationStatus,
} from './conversation-states';
import { CustomerService } from './customer.service';
import { TaggableEntity } from './entities/customer-metadata.entity';
import { QueryBoolean } from '../../common/http/query-boolean';

export class ListConversationsDto {
  @IsOptional() @IsEnum(ConversationStatus) status?: ConversationStatus;
  @IsOptional() @IsEnum(ConversationKind) kind?: ConversationKind;
  @IsOptional() @IsEnum(ConversationControlState) controlState?: ConversationControlState;
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsUUID() assignedToUserId?: string;
  @IsOptional() @IsUUID() assignedToTeamId?: string;
  @IsOptional() @IsUUID() channelAccountId?: string;
  @IsOptional() @QueryBoolean() @IsBoolean() unassignedOnly?: boolean;
  @IsOptional() @QueryBoolean() @IsBoolean() pinnedOnly?: boolean;
  @IsOptional() @QueryBoolean() @IsBoolean() activeOnly?: boolean;
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

export class SetStatusDto {
  @IsEnum(ConversationStatus) status!: ConversationStatus;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class SetControlStateDto {
  @IsEnum(ConversationControlState) controlState!: ConversationControlState;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  /** Only meaningful with PAUSED. */
  @IsOptional() @IsISO8601() pausedUntil?: string;
}

export class TakeoverDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  /** Without an expiry the takeover holds until explicitly released. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(24 * 60) expiresInMinutes?: number;
}

export class ReleaseDto {
  @IsOptional() @IsEnum(ConversationControlState) releaseTo?: ConversationControlState;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class AssignDto {
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsUUID() teamId?: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class SetFlagsDto {
  @IsOptional() @IsBoolean() aiEnabled?: boolean;
  @IsOptional() @IsBoolean() automationEnabled?: boolean;
  @IsOptional() @IsEnum(ConversationPriority) priority?: ConversationPriority;
  @IsOptional() @IsBoolean() isPinned?: boolean;
}

export class MessageHistoryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  /** Cursor: the `sentAt` of the oldest message you already have. */
  @IsOptional() @IsISO8601() before?: string;
  @IsOptional() @IsUUID() beforeId?: string;
}

/**
 * Conversations (Phase 3 brief §3, §6, §7, §8, §10, §13, §14).
 *
 * Every route that changes state is audited and permission-gated. `conversations.takeover` is a
 * permission distinct from `conversations.manage` because taking a conversation away from
 * automation is a different kind of authority from tagging or resolving it, and
 * `PROJECT_SPEC.md` §108 lists them separately for that reason.
 *
 * Nothing here decides anything: the routes record what an operator chose. Interpretation is the
 * Phase 5 decision engine's job (brief §6, §16).
 */
@ApiTags('conversations')
@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly conversations: ConversationService,
    private readonly customers: CustomerService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('conversations.read')
  @ApiOperation({ summary: 'The inbox query — paginated, filterable, searchable' })
  async list(@Query() query: ListConversationsDto) {
    return this.conversations.list(query);
  }

  @Get(':id')
  @RequirePermissions('conversations.read')
  @ApiOperation({ summary: 'One conversation, including its derived PROJECT_SPEC.md §7 state and tags' })
  async findOne(@Param('id') id: string) {
    const conversation = await this.conversations.findOne(id);
    const tags = await this.customers.listTagsFor(TaggableEntity.CONVERSATION, id);
    return { ...this.conversations.withSpecState(conversation), tags };
  }

  @Get(':id/messages')
  @RequirePermissions('messages.read')
  @ApiOperation({
    summary: 'Message history (cursor-paginated, newest first)',
    description:
      'Cursor-based rather than offset-based: a live conversation grows while it is being read, and ' +
      'offset paging silently skips or repeats rows when it does.',
  })
  async messages(@Param('id') id: string, @Query() query: MessageHistoryDto) {
    return this.conversations.listMessages(id, {
      limit: query.limit,
      before: query.before ? new Date(query.before) : undefined,
      beforeId: query.beforeId,
    });
  }

  @Get(':id/participants')
  @RequirePermissions('conversations.read')
  @ApiOperation({ summary: 'Participants, including departed ones when asked' })
  async participants(@Param('id') id: string, @Query('includeInactive') includeInactive?: string) {
    return this.conversations.listParticipants(id, includeInactive === 'true');
  }

  @Get(':id/state-history')
  @RequirePermissions('conversations.read')
  @ApiOperation({ summary: 'Every status and control-state change, with actor and reason' })
  async stateHistory(@Param('id') id: string, @Query() query: { limit?: number; offset?: number }) {
    return this.conversations.listStateHistory(id, {
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
    });
  }

  @Get(':id/assignment-history')
  @RequirePermissions('conversations.read')
  @ApiOperation({ summary: 'Assignment history — never overwritten, so past ownership stays answerable' })
  async assignmentHistory(@Param('id') id: string, @Query() query: { limit?: number; offset?: number }) {
    return this.conversations.listAssignmentHistory(id, {
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
    });
  }

  // === state ======================================================================================

  @Post(':id/status')
  @RequirePermissions('conversations.manage')
  @ApiOperation({ summary: 'Move the lifecycle status (validated against the transition table)' })
  async setStatus(
    @Param('id') id: string,
    @Body() dto: SetStatusDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const before = await this.conversations.findOne(id);
    const after = await this.conversations.setStatus(
      id,
      dto.status,
      { id: user.id, username: user.username },
      { reason: dto.reason },
    );

    await this.audit.record(
      {
        action: 'conversations.status_changed',
        resource: 'conversation',
        resourceId: id,
        before: { status: before.status },
        after: { status: after.status },
        metadata: { reason: dto.reason ?? null },
      },
      this.audit.actorFromRequest(request, user),
    );

    return this.conversations.withSpecState(after);
  }

  @Post(':id/control-state')
  @RequirePermissions('conversations.takeover')
  @ApiOperation({ summary: 'Move the control axis — who is allowed to respond' })
  async setControlState(
    @Param('id') id: string,
    @Body() dto: SetControlStateDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const before = await this.conversations.findOne(id);
    const after = await this.conversations.setControlState(
      id,
      dto.controlState,
      { id: user.id, username: user.username },
      { reason: dto.reason, pausedUntil: dto.pausedUntil ? new Date(dto.pausedUntil) : null },
    );

    await this.audit.record(
      {
        action: 'conversations.control_state_changed',
        resource: 'conversation',
        resourceId: id,
        before: { controlState: before.controlState },
        after: { controlState: after.controlState, pausedUntil: after.pausedUntil },
        metadata: { reason: dto.reason ?? null },
      },
      this.audit.actorFromRequest(request, user),
    );

    return this.conversations.withSpecState(after);
  }

  @Post(':id/takeover')
  @RequirePermissions('conversations.takeover')
  @ApiOperation({
    summary: 'Take the conversation as a human',
    description:
      'Sets HUMAN_ACTIVE and records who, why, when and optionally until when. Phase 5 will read ' +
      'this state and stop automated responders; Phase 3 only records it.',
  })
  async takeover(
    @Param('id') id: string,
    @Body() dto: TakeoverDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const before = await this.conversations.findOne(id);
    const after = await this.conversations.startTakeover(
      id,
      { id: user.id, username: user.username },
      { reason: dto.reason, expiresInMinutes: dto.expiresInMinutes },
    );

    await this.audit.record(
      {
        action: 'conversations.takeover_started',
        resource: 'conversation',
        resourceId: id,
        before: { controlState: before.controlState },
        after: {
          controlState: after.controlState,
          takeoverByUserId: after.takeoverByUserId,
          takeoverExpiresAt: after.takeoverExpiresAt,
        },
        metadata: { reason: dto.reason ?? null },
      },
      this.audit.actorFromRequest(request, user),
    );

    return this.conversations.withSpecState(after);
  }

  @Post(':id/release')
  @RequirePermissions('conversations.takeover')
  @ApiOperation({
    summary: 'Release a takeover',
    description:
      'Defaults to AUTOMATION_ACTIVE. Releasing to AI is an explicit choice, not the default — the ' +
      'least autonomous responder is the conservative landing point.',
  })
  async release(
    @Param('id') id: string,
    @Body() dto: ReleaseDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const after = await this.conversations.endTakeover(
      id,
      { id: user.id, username: user.username },
      { releaseTo: dto.releaseTo, reason: dto.reason },
    );

    await this.audit.record(
      {
        action: 'conversations.takeover_ended',
        resource: 'conversation',
        resourceId: id,
        after: { controlState: after.controlState },
        metadata: { reason: dto.reason ?? null },
      },
      this.audit.actorFromRequest(request, user),
    );

    return this.conversations.withSpecState(after);
  }

  // === assignment ==================================================================================

  @Post(':id/assign')
  @RequirePermissions('conversations.manage')
  @ApiOperation({ summary: 'Assign to exactly one of a user or a team; history is preserved' })
  async assign(
    @Param('id') id: string,
    @Body() dto: AssignDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const before = await this.conversations.findOne(id);
    const after = await this.conversations.assign(
      id,
      { userId: dto.userId, teamId: dto.teamId },
      { id: user.id, username: user.username },
      dto.reason,
    );

    await this.audit.record(
      {
        action: 'conversations.assigned',
        resource: 'conversation',
        resourceId: id,
        before: { assignedToUserId: before.assignedToUserId, assignedToTeamId: before.assignedToTeamId },
        after: { assignedToUserId: after.assignedToUserId, assignedToTeamId: after.assignedToTeamId },
        metadata: { reason: dto.reason ?? null },
      },
      this.audit.actorFromRequest(request, user),
    );

    return this.conversations.withSpecState(after);
  }

  @Post(':id/unassign')
  @RequirePermissions('conversations.manage')
  @ApiOperation({ summary: 'Clear the assignment (the history row is closed, never deleted)' })
  async unassign(
    @Param('id') id: string,
    @Body() dto: { reason?: string },
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const before = await this.conversations.findOne(id);
    const after = await this.conversations.unassign(
      id,
      { id: user.id, username: user.username },
      dto?.reason,
    );

    await this.audit.record(
      {
        action: 'conversations.unassigned',
        resource: 'conversation',
        resourceId: id,
        before: { assignedToUserId: before.assignedToUserId, assignedToTeamId: before.assignedToTeamId },
        after: { assignedToUserId: null, assignedToTeamId: null },
      },
      this.audit.actorFromRequest(request, user),
    );

    return this.conversations.withSpecState(after);
  }

  // === flags and tags ==============================================================================

  @Patch(':id/flags')
  @RequirePermissions('conversations.manage')
  @ApiOperation({ summary: 'Set per-conversation AI/automation flags, priority and pin' })
  async setFlags(
    @Param('id') id: string,
    @Body() dto: SetFlagsDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const { before, after } = await this.conversations.setFlags(id, dto, {
      id: user.id,
      username: user.username,
    });

    await this.audit.record(
      {
        action: 'conversations.flags_changed',
        resource: 'conversation',
        resourceId: id,
        before,
        after: {
          aiEnabled: after.aiEnabled,
          automationEnabled: after.automationEnabled,
          priority: after.priority,
          isPinned: after.isPinned,
        },
      },
      this.audit.actorFromRequest(request, user),
    );

    return this.conversations.withSpecState(after);
  }

  @Post(':id/tags')
  @RequirePermissions('conversations.manage')
  @ApiOperation({ summary: 'Attach a tag to a conversation' })
  async addTag(
    @Param('id') id: string,
    @Body() dto: { tagKey: string },
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    await this.conversations.findOne(id);
    const tag = await this.customers.addTag(TaggableEntity.CONVERSATION, id, dto.tagKey, user.id);

    await this.audit.record(
      { action: 'conversations.tag_added', resource: 'conversation', resourceId: id, after: { tag: tag.key } },
      this.audit.actorFromRequest(request, user),
    );

    return tag;
  }
}
