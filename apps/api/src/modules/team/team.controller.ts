import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import { ChannelKey } from '../channel/entities/channel.entity';
import { CurrentUser, RequirePermissions } from '../rbac/permissions.guard';
import { TeamIdentityService } from './team-identity.service';

export class CreateIdentityDto {
  @IsEnum(ChannelKey) channelKey!: ChannelKey;

  /** Any human format; normalised to bare digits before storage. */
  @IsString() @MinLength(7) @MaxLength(32) phone!: string;

  @IsString() @MinLength(1) @MaxLength(160) displayName!: string;

  /** Link to a Support CRM login. Optional — many team members never use the dashboard. */
  @IsOptional() @IsUUID() userId?: string;

  @IsOptional() @IsString() @MaxLength(80) jobRole?: string;
}

export class UpdateIdentityDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(160) displayName?: string;
  @IsOptional() @IsString() @MaxLength(80) jobRole?: string;
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class ListIdentitiesDto {
  @IsOptional() @IsEnum(ChannelKey) channelKey?: ChannelKey;
  @IsOptional() @Type(() => Boolean) @IsBoolean() includeInactive?: boolean;
}

/**
 * Team member channel identities (brief §9).
 *
 * These rows are what let the system tell a support executive apart from a customer. They do NOT by
 * themselves mean a message counts as support activity — that classification lands in Phase 3.
 */
@ApiTags('team')
@Controller('team/identities')
export class TeamController {
  constructor(
    private readonly identities: TeamIdentityService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('team.manage')
  @ApiOperation({ summary: 'List team member channel identities' })
  async list(@Query() query: ListIdentitiesDto) {
    return this.identities.list(query);
  }

  @Post()
  @RequirePermissions('team.manage')
  @ApiOperation({ summary: 'Associate a WhatsApp identity with a team member' })
  async create(
    @Body() dto: CreateIdentityDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const identity = await this.identities.create({
      channelKey: dto.channelKey,
      phone: dto.phone,
      displayName: dto.displayName,
      userId: dto.userId ?? null,
      jobRole: dto.jobRole ?? null,
    });

    await this.audit.record(
      {
        action: 'team.identity_created',
        resource: 'team_member_identity',
        resourceId: identity.id,
        // The phone number is PII. The audit trail records that an identity was created and for
        // whom, not the number itself (`PROJECT_SPEC.md` §110).
        after: {
          channelKey: identity.channelKey,
          displayName: identity.displayName,
          linkedUserId: identity.userId,
        },
      },
      this.audit.actorFromRequest(request, user),
    );

    return serialize(identity);
  }

  @Patch(':id')
  @RequirePermissions('team.manage')
  @ApiOperation({ summary: 'Update a team member identity' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateIdentityDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const before = await this.identities.findOne(id);
    const updated = await this.identities.update(id, dto);

    await this.audit.record(
      {
        action: 'team.identity_updated',
        resource: 'team_member_identity',
        resourceId: id,
        before: { displayName: before.displayName, isActive: before.isActive, linkedUserId: before.userId },
        after: { displayName: updated.displayName, isActive: updated.isActive, linkedUserId: updated.userId },
      },
      this.audit.actorFromRequest(request, user),
    );

    return serialize(updated);
  }

  /** Deactivates rather than deletes, so historical classification stays explicable. */
  @Post(':id/deactivate')
  @RequirePermissions('team.manage')
  @ApiOperation({ summary: 'Deactivate an identity (never deleted — history must stay explicable)' })
  async deactivate(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const identity = await this.identities.deactivate(id);
    await this.audit.record(
      { action: 'team.identity_deactivated', resource: 'team_member_identity', resourceId: id },
      this.audit.actorFromRequest(request, user),
    );
    return serialize(identity);
  }
}

/**
 * The phone number IS returned here — unlike in logs and audit rows.
 *
 * This route requires `team.manage`, and an admin managing team identities plainly needs to see
 * which number is mapped to whom, or the feature is unusable.
 */
function serialize(identity: {
  id: string;
  channelKey: string;
  externalId: string;
  phone: string;
  displayName: string;
  jobRole: string | null;
  userId: string | null;
  isActive: boolean;
  createdAt: Date;
}) {
  return {
    id: identity.id,
    channelKey: identity.channelKey,
    externalId: identity.externalId,
    phone: identity.phone,
    displayName: identity.displayName,
    jobRole: identity.jobRole,
    userId: identity.userId,
    isActive: identity.isActive,
    createdAt: identity.createdAt,
  };
}
