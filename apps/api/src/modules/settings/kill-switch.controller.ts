import { BadRequestException, Body, Controller, Get, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermissions } from '../rbac/permissions.guard';
import { KillSwitchService } from './kill-switch.service';

export class SetSwitchDto {
  @IsString() @MaxLength(120) key!: string;
  @IsBoolean() engaged!: boolean;
  /**
   * Typed by the operator to confirm.
   *
   * A checkbox is too easy to hit by accident for something that stops customer replies across the
   * whole system. The UI asks for the word; this validates that it arrived.
   */
  @IsString() @MaxLength(40) confirm!: string;
}

/**
 * The emergency controls (`PROJECT_SPEC.md` §37).
 *
 * Separate from the settings API on purpose. These five keys are writable through `/settings` too,
 * but that route treats them as configuration; this one treats them as an emergency — it requires a
 * typed confirmation, reports the blast radius, and cancels what is already queued.
 */
@ApiTags('emergency')
@Controller({ path: 'emergency', version: '1' })
export class KillSwitchController {
  constructor(
    private readonly killSwitch: KillSwitchService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('settings.read')
  @ApiOperation({ summary: 'Every emergency control and whether it is engaged' })
  async list() {
    return {
      items: await this.killSwitch.list(),
      // Shown before anything is pressed, so "stop everything" is a decision with a known cost.
      pendingOutbound: await this.killSwitch.pendingOutboundCount(),
    };
  }

  @Post()
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Engage or release one control. Cancels queued messages where it applies.' })
  async set(@Body() dto: SetSwitchDto, @CurrentUser() user: AuthenticatedUser, @Req() request: Request) {
    if (!this.killSwitch.isKnown(dto.key)) {
      throw new BadRequestException('That is not an emergency control.');
    }
    if (dto.confirm.trim().toUpperCase() !== (dto.engaged ? 'STOP' : 'RESUME')) {
      throw new BadRequestException(
        `Type ${dto.engaged ? 'STOP' : 'RESUME'} to confirm. This affects every conversation in the system.`,
      );
    }

    const outcome = await this.killSwitch.set(dto.key, dto.engaged, user.id);

    await this.audit.record(
      {
        action: 'system.emergency_stop',
        resource: 'setting',
        resourceId: dto.key,
        after: { engaged: outcome.engaged, cancelledOutbound: outcome.cancelled },
      },
      this.audit.actorFromRequest(request, user),
    );

    return outcome;
  }
}
