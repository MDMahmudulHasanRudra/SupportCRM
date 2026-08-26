import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Allow, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermissions } from '../rbac/permissions.guard';
import { BroadcastService } from './broadcast.service';
import { BroadcastStatus } from './entities/broadcast.entity';
import { BroadcastRecipientStatus } from './entities/broadcast-recipient.entity';

export class TestSendDto {
  /** A chat id on the campaign's own account. A test that goes to a stranger is not a test. */
  @IsString() @MinLength(3) @MaxLength(190) externalConversationId!: string;
}

export class CreateBroadcastDto {
  @IsString() @MinLength(1) @MaxLength(160) name!: string;
  @IsString() @MinLength(1) @MaxLength(4000) body!: string;
  @IsUUID() channelAccountId!: string;
  @Allow() target!: { groupIds?: string[]; conversationIds?: string[] };
  @IsOptional() @IsString() scheduledAt?: string;
}

/**
 * Campaigns (`PROJECT_SPEC.md` §57).
 *
 * Creating and starting are separate permissions and separate actions: writing a message that will
 * reach two thousand customers, and deciding to actually send it, are different decisions.
 */
@ApiTags('broadcasts')
@Controller({ path: 'broadcasts', version: '1' })
export class BroadcastController {
  constructor(
    private readonly broadcasts: BroadcastService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('broadcast.create')
  @ApiOperation({ summary: 'List campaigns' })
  async list(@Query('status') status?: BroadcastStatus) {
    return this.broadcasts.list({ status });
  }

  @Get(':id')
  @RequirePermissions('broadcast.create')
  @ApiOperation({ summary: 'One campaign with its counters' })
  async findOne(@Param('id') id: string) {
    return this.broadcasts.findOne(id);
  }

  @Post()
  @RequirePermissions('broadcast.create')
  @ApiOperation({ summary: 'Create a campaign (nothing is sent until it is started)' })
  async create(@Body() dto: CreateBroadcastDto, @CurrentUser() user: AuthenticatedUser, @Req() request: Request) {
    const broadcast = await this.broadcasts.create(
      {
        name: dto.name,
        body: dto.body,
        channelAccountId: dto.channelAccountId,
        target: dto.target,
        scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
      },
      user.id,
    );

    await this.audit.record(
      {
        action: 'broadcast.created',
        resource: 'broadcast',
        resourceId: broadcast.id,
        after: { name: broadcast.name, target: broadcast.target },
      },
      this.audit.actorFromRequest(request, user),
    );
    return broadcast;
  }

  @Post(':id/start')
  @RequirePermissions('broadcast.send')
  @ApiOperation({ summary: 'Resolve recipients and queue the sends' })
  async start(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Req() request: Request) {
    const broadcast = await this.broadcasts.start(id, user.id);

    await this.audit.record(
      {
        action: 'broadcast.started',
        resource: 'broadcast',
        resourceId: id,
        after: { totalCount: broadcast.totalCount, jobId: broadcast.jobId },
      },
      this.audit.actorFromRequest(request, user),
    );
    return broadcast;
  }

  @Get(':id/preview')
  @RequirePermissions('broadcast.create')
  @ApiOperation({ summary: 'Who this would reach, and what was excluded — before starting it' })
  async preview(@Param('id') id: string) {
    return this.broadcasts.preview(id);
  }

  @Get(':id/recipients')
  @RequirePermissions('broadcast.create')
  @ApiOperation({ summary: 'Per-recipient outcomes, so a failure is attributable' })
  async recipients(@Param('id') id: string, @Query('status') status?: BroadcastRecipientStatus) {
    return this.broadcasts.recipientsFor(id, status);
  }

  @Post(':id/test')
  @RequirePermissions('broadcast.send')
  @ApiOperation({ summary: 'Send one copy to a single address, before committing to the audience' })
  async test(
    @Param('id') id: string,
    @Body() dto: TestSendDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const broadcast = await this.broadcasts.testSend(id, dto.externalConversationId, user.id);

    await this.audit.record(
      {
        action: 'broadcast.test_sent',
        resource: 'broadcast',
        resourceId: id,
        after: { to: dto.externalConversationId },
      },
      this.audit.actorFromRequest(request, user),
    );

    return broadcast;
  }

  @Post(':id/cancel')
  @RequirePermissions('broadcast.send')
  @ApiOperation({ summary: 'Cancel a running campaign' })
  async cancel(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Req() request: Request) {
    const broadcast = await this.broadcasts.cancel(id);

    await this.audit.record(
      { action: 'broadcast.cancelled', resource: 'broadcast', resourceId: id, after: { status: broadcast.status } },
      this.audit.actorFromRequest(request, user),
    );
    return broadcast;
  }
}
