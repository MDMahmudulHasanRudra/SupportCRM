import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermissions } from '../rbac/permissions.guard';
import { EscalationStatus } from './entities/escalation.entity';
import { EscalationService } from './escalation.service';

export class ListEscalationsDto {
  @IsOptional() @IsEnum(EscalationStatus) status?: EscalationStatus;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

export class AssignEscalationDto {
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsUUID() teamId?: string;
}

export class ResolveEscalationDto {
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  /**
   * Hand the conversation back to automation.
   *
   * Deliberate rather than automatic: an agent who answered a billing question may want the machine
   * responding again, and one who calmed an angry customer very much may not.
   */
  @IsOptional() @IsBoolean() releaseToAutomation?: boolean;
  @IsOptional() @IsBoolean() dismiss?: boolean;
}

@ApiTags('escalations')
@Controller({ path: 'escalations', version: '1' })
export class EscalationController {
  constructor(
    private readonly escalations: EscalationService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('conversations.read')
  @ApiOperation({ summary: 'Conversations waiting for a human' })
  async list(@Query() query: ListEscalationsDto) {
    return this.escalations.list(query);
  }

  @Get(':id')
  @RequirePermissions('conversations.read')
  @ApiOperation({ summary: 'One escalation' })
  async findOne(@Param('id') id: string) {
    return this.escalations.findOne(id);
  }

  @Post(':id/assign')
  @RequirePermissions('conversations.manage')
  @ApiOperation({ summary: 'Assign an escalation to a person or a team' })
  async assign(
    @Param('id') id: string,
    @Body() dto: AssignEscalationDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const escalation = await this.escalations.assign(id, { userId: dto.userId, teamId: dto.teamId });

    await this.audit.record(
      {
        action: 'escalations.assigned',
        resource: 'escalation',
        resourceId: id,
        after: { assignedToUserId: escalation.assignedToUserId, assignedToTeamId: escalation.assignedToTeamId },
      },
      this.audit.actorFromRequest(request, user),
    );
    return escalation;
  }

  @Post(':id/resolve')
  @RequirePermissions('conversations.manage')
  @ApiOperation({ summary: 'Close an escalation, optionally returning the conversation to automation' })
  async resolve(
    @Param('id') id: string,
    @Body() dto: ResolveEscalationDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const escalation = await this.escalations.resolve(id, {
      userId: user.id,
      note: dto.note ?? null,
      releaseToAutomation: dto.releaseToAutomation,
      dismiss: dto.dismiss,
    });

    await this.audit.record(
      {
        action: 'escalations.resolved',
        resource: 'escalation',
        resourceId: id,
        after: { status: escalation.status, released: dto.releaseToAutomation === true },
      },
      this.audit.actorFromRequest(request, user),
    );
    return escalation;
  }
}
