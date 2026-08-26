import { Body, Controller, Get, Param, Put, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import { AutomationProfile } from '../automation/entities/automation-profile.entity';
import { Group } from '../groups/entities/group.entity';
import { CurrentUser, RequirePermissions } from '../rbac/permissions.guard';
import { SettingsService } from '../settings/settings.service';
import { EscalationNotifier } from './escalation-notifier.service';
import { DEFAULT_ESCALATION_POLICY, mergeEscalationPolicy, type EscalationPolicy } from './escalation-policy';

/** The settings key holding the global escalation policy — the broadest layer of the hierarchy. */
export const GLOBAL_ESCALATION_POLICY_KEY = 'escalation.global_policy';

export class EscalationPolicyDto {
  @IsOptional() @IsUUID() internalGroupId?: string;
  @IsOptional() @IsUUID() primaryExecutiveUserId?: string;
  @IsOptional() @IsUUID() secondaryExecutiveUserId?: string;
  @IsOptional() @IsBoolean() notifyInternalGroup?: boolean;
  @IsOptional() @IsBoolean() notifyExecutives?: boolean;
  @IsOptional() @IsBoolean() notifyCustomer?: boolean;
  @IsOptional() @IsString() @MaxLength(500) customerNotice?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) maxAiAttempts?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) maxAiReplies?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) maxConsecutiveAiReplies?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) humanReplyCooldownSeconds?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) escalationScoreThreshold?: number;
  @IsOptional() @IsString() @MaxLength(2000) guidance?: string;
}

/**
 * Who gets told, and when (`PROJECT_SPEC.md` §30, §33, §34).
 *
 * The hierarchy is Global → Support Profile → Group, and this controller edits all three through
 * one shape. `effective` resolves the merge for a given group so an operator can see the numbers
 * actually in force rather than inferring them from three screens.
 *
 * Every field is optional at every level: a scope states only what it changes.
 */
@ApiTags('escalations')
@Controller({ path: 'escalations/config', version: '1' })
export class EscalationConfigController {
  constructor(
    @InjectRepository(Group) private readonly groups: Repository<Group>,
    @InjectRepository(AutomationProfile) private readonly profiles: Repository<AutomationProfile>,
    private readonly settings: SettingsService,
    private readonly notifier: EscalationNotifier,
    private readonly audit: AuditService,
  ) {}

  @Get('defaults')
  @RequirePermissions('conversations.read')
  @ApiOperation({ summary: 'The built-in defaults, before any configuration' })
  defaults() {
    return DEFAULT_ESCALATION_POLICY;
  }

  @Get('global')
  @RequirePermissions('conversations.read')
  @ApiOperation({ summary: 'The global escalation policy' })
  async global() {
    const stored = await this.settings.get<EscalationPolicy>(GLOBAL_ESCALATION_POLICY_KEY, {});
    return { stored: stored ?? {}, effective: mergeEscalationPolicy(stored) };
  }

  @Put('global')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Set the global escalation policy' })
  async setGlobal(
    @Body() dto: EscalationPolicyDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    await this.settings.set(GLOBAL_ESCALATION_POLICY_KEY, dto, {
      valueType: 'json' as never,
      category: 'escalation',
      updatedById: user.id,
    });

    await this.audit.record(
      {
        action: 'escalations.policy_changed',
        resource: 'setting',
        resourceId: GLOBAL_ESCALATION_POLICY_KEY,
        after: { notifyExecutives: dto.notifyExecutives, internalGroupId: dto.internalGroupId },
      },
      this.audit.actorFromRequest(request, user),
    );

    return { stored: dto, effective: mergeEscalationPolicy(dto) };
  }

  @Put('group/:groupId')
  @RequirePermissions('groups.update')
  @ApiOperation({ summary: "Override the policy for one group — the narrowest layer" })
  async setGroup(
    @Param('groupId') groupId: string,
    @Body() dto: EscalationPolicyDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    await this.groups.update(groupId, { escalationPolicy: dto as never });

    await this.audit.record(
      { action: 'escalations.policy_changed', resource: 'group', resourceId: groupId, after: { ...dto } },
      this.audit.actorFromRequest(request, user),
    );

    return this.effective(groupId);
  }

  @Put('profile/:profileId')
  @RequirePermissions('automation.approve')
  @ApiOperation({ summary: 'Override the policy for one automation profile' })
  async setProfile(
    @Param('profileId') profileId: string,
    @Body() dto: EscalationPolicyDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    await this.profiles.update(profileId, { escalationPolicy: dto as never });

    await this.audit.record(
      {
        action: 'escalations.policy_changed',
        resource: 'automation_profile',
        resourceId: profileId,
        after: { ...dto },
      },
      this.audit.actorFromRequest(request, user),
    );

    return this.profiles.findOneOrFail({ where: { id: profileId } });
  }

  /**
   * What a given group actually resolves to.
   *
   * Returns each layer as well as the merge, because "why is this group notifying executives?" is
   * a question about which layer set it, not just about the final value.
   */
  @Get('effective')
  @RequirePermissions('conversations.read')
  @ApiOperation({ summary: 'The merged policy for a group, and the layers that produced it' })
  async effective(@Query('groupId') groupId?: string) {
    const globalPolicy = (await this.settings.get<EscalationPolicy>(GLOBAL_ESCALATION_POLICY_KEY, {})) ?? {};

    const group = groupId ? await this.groups.findOne({ where: { id: groupId } }) : null;
    const profile = group?.automationProfileId
      ? await this.profiles.findOne({ where: { id: group.automationProfileId } })
      : null;

    const layers = {
      defaults: DEFAULT_ESCALATION_POLICY,
      global: globalPolicy,
      profile: (profile?.escalationPolicy as EscalationPolicy | null) ?? null,
      group: (group?.escalationPolicy as EscalationPolicy | null) ?? null,
    };

    return {
      layers,
      effective: mergeEscalationPolicy(globalPolicy, layers.profile, layers.group),
    };
  }

  @Get(':escalationId/events')
  @RequirePermissions('conversations.read')
  @ApiOperation({ summary: 'Every notification attempted for one escalation, and what happened' })
  async events(@Param('escalationId') escalationId: string) {
    return { items: await this.notifier.eventsFor(escalationId) };
  }
}
