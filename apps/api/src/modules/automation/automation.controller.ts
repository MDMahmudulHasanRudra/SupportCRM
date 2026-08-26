import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import {
  Allow,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { Request } from 'express';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermissions } from '../rbac/permissions.guard';
import {
  AutomationStatus,
  RuleScopeType,
  type RuleAction,
  type RuleConditionSet,
} from './automation-types';
import { AutomationRuleService } from './automation-rule.service';
import { AutomationProfile } from './entities/automation-profile.entity';

export class CreateRuleDto {
  @IsString() @MinLength(1) @MaxLength(160) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsUUID() profileId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(-1000) @Max(1000) priority?: number;
  @IsOptional() @IsEnum(RuleScopeType) scopeType?: RuleScopeType;
  @IsOptional() @IsUUID() scopeId?: string;
  /**
   * Validated structurally by the evaluator, which is the one place that knows the shape.
   *
   * `@Allow()` because the global pipe whitelists decorated properties only, and an undecorated
   * one is silently stripped.
   */
  @Allow() conditions!: RuleConditionSet;
  @IsArray() actions!: RuleAction[];
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) cooldownSeconds?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) maxExecutions?: number;
}

export class UpdateRuleDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(160) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(-1000) @Max(1000) priority?: number;
  @IsOptional() @IsEnum(RuleScopeType) scopeType?: RuleScopeType;
  @IsOptional() @IsUUID() scopeId?: string;
  @IsOptional() @Allow() conditions?: RuleConditionSet;
  @IsOptional() @IsArray() actions?: RuleAction[];
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) cooldownSeconds?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) maxExecutions?: number;
}

export class ListRulesDto {
  @IsOptional() @IsEnum(AutomationStatus) status?: AutomationStatus;
  @IsOptional() @IsEnum(RuleScopeType) scopeType?: RuleScopeType;
  @IsOptional() @IsUUID() scopeId?: string;
  @IsOptional() @IsUUID() profileId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

export class TransitionRuleDto {
  @IsEnum(AutomationStatus) status!: AutomationStatus;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class RollbackRuleDto {
  @Type(() => Number) @IsInt() @Min(1) version!: number;
}

export class CreateProfileDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsBoolean() aiEnabled?: boolean;
  @IsOptional() @IsBoolean() automationEnabled?: boolean;
  @IsOptional() @IsUUID() knowledgeProfileId?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(1) autoReplyMinConfidence?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) escalateBelowConfidence?: number;
  @IsOptional() @IsString() @MaxLength(16) midConfidencePolicy?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) humanTakeoverMinutes?: number;
  @IsOptional() @IsUUID() assignedTeamId?: string;
}

/**
 * Automation rules and profiles (`PROJECT_SPEC.md` §76–§80, §199).
 *
 * Two permission tiers, deliberately: `automation.create` writes and withdraws, `automation.approve`
 * activates. Somebody who can write a rule should not thereby be able to put its words in front of
 * customers.
 */
@ApiTags('automation')
@Controller({ path: 'automation', version: '1' })
export class AutomationController {
  constructor(
    private readonly rules: AutomationRuleService,
    @InjectRepository(AutomationProfile) private readonly profiles: Repository<AutomationProfile>,
    private readonly audit: AuditService,
  ) {}

  // === rules =======================================================================================

  @Get('rules')
  @RequirePermissions('automation.read')
  @ApiOperation({ summary: 'List automation rules' })
  async list(@Query() query: ListRulesDto) {
    return this.rules.list(query);
  }

  @Get('rules/:id')
  @RequirePermissions('automation.read')
  @ApiOperation({ summary: 'One rule' })
  async findOne(@Param('id') id: string) {
    return this.rules.findOne(id);
  }

  @Post('rules')
  @RequirePermissions('automation.create')
  @ApiOperation({ summary: 'Create a rule (always as a draft)' })
  async create(@Body() dto: CreateRuleDto, @CurrentUser() user: AuthenticatedUser, @Req() request: Request) {
    const rule = await this.rules.create(dto, user.id);

    await this.audit.record(
      {
        action: 'automation.rule_created',
        resource: 'automation_rule',
        resourceId: rule.id,
        after: { name: rule.name, scopeType: rule.scopeType, priority: rule.priority },
      },
      this.audit.actorFromRequest(request, user),
    );
    return rule;
  }

  @Patch('rules/:id')
  @RequirePermissions('automation.create')
  @ApiOperation({ summary: 'Edit a rule (editing an active rule returns it to draft)' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateRuleDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const before = await this.rules.findOne(id);
    const rule = await this.rules.update(id, dto, user.id);

    await this.audit.record(
      {
        action: 'automation.rule_updated',
        resource: 'automation_rule',
        resourceId: id,
        before: { status: before.status, version: before.currentVersion, priority: before.priority },
        after: { status: rule.status, version: rule.currentVersion, priority: rule.priority },
      },
      this.audit.actorFromRequest(request, user),
    );
    return rule;
  }

  /**
   * Changes a rule's status.
   *
   * Activation demands `automation.approve` — it is the moment a rule starts speaking to customers.
   */
  @Post('rules/:id/status')
  @RequirePermissions('automation.create')
  @ApiOperation({ summary: 'Change rule status (activation needs automation.approve)' })
  async transition(
    @Param('id') id: string,
    @Body() dto: TransitionRuleDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    if (dto.status === AutomationStatus.ACTIVE && !user.permissions.has('automation.approve')) {
      throw new ForbiddenException('Activating a rule requires the automation.approve permission.');
    }

    const before = await this.rules.findOne(id);
    const rule = await this.rules.transition(id, dto.status, user.id, dto.note);

    await this.audit.record(
      {
        action: 'automation.rule_status_changed',
        resource: 'automation_rule',
        resourceId: id,
        before: { status: before.status },
        after: { status: rule.status },
      },
      this.audit.actorFromRequest(request, user),
    );
    return rule;
  }

  @Get('rules/:id/versions')
  @RequirePermissions('automation.read')
  @ApiOperation({ summary: 'Rule version history' })
  async versions(@Param('id') id: string) {
    return { items: await this.rules.listVersions(id) };
  }

  @Post('rules/:id/rollback')
  @RequirePermissions('automation.approve')
  @ApiOperation({ summary: 'Restore an earlier version as a new draft version' })
  async rollback(
    @Param('id') id: string,
    @Body() dto: RollbackRuleDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const rule = await this.rules.rollback(id, dto.version, user.id);

    await this.audit.record(
      {
        action: 'automation.rule_rolled_back',
        resource: 'automation_rule',
        resourceId: id,
        after: { restoredFrom: dto.version, version: rule.currentVersion, status: rule.status },
      },
      this.audit.actorFromRequest(request, user),
    );
    return rule;
  }

  @Delete('rules/:id')
  @RequirePermissions('automation.approve')
  @ApiOperation({ summary: 'Delete a rule' })
  async remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Req() request: Request) {
    const rule = await this.rules.findOne(id);
    await this.rules.remove(id);

    await this.audit.record(
      { action: 'automation.rule_deleted', resource: 'automation_rule', resourceId: id, before: { name: rule.name } },
      this.audit.actorFromRequest(request, user),
    );
    return { deleted: true };
  }

  // === profiles ====================================================================================

  @Get('profiles')
  @RequirePermissions('automation.read')
  @ApiOperation({ summary: 'List automation profiles' })
  async listProfiles() {
    return { items: await this.profiles.find({ order: { name: 'ASC' } }) };
  }

  @Post('profiles')
  @RequirePermissions('automation.approve')
  @ApiOperation({ summary: 'Create an automation profile' })
  async createProfile(
    @Body() dto: CreateProfileDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const profile = await this.profiles.save(
      this.profiles.create({
        name: dto.name.trim(),
        description: dto.description ?? null,
        // Created ACTIVE: a profile is configuration rather than customer-facing words, and the
        // rules it carries have their own approval gate.
        status: AutomationStatus.ACTIVE,
        aiEnabled: dto.aiEnabled ?? false,
        automationEnabled: dto.automationEnabled ?? true,
        knowledgeProfileId: dto.knowledgeProfileId ?? null,
        autoReplyMinConfidence:
          dto.autoReplyMinConfidence === undefined ? null : String(dto.autoReplyMinConfidence),
        escalateBelowConfidence:
          dto.escalateBelowConfidence === undefined ? null : String(dto.escalateBelowConfidence),
        midConfidencePolicy: dto.midConfidencePolicy ?? null,
        humanTakeoverMinutes: dto.humanTakeoverMinutes ?? null,
        assignedTeamId: dto.assignedTeamId ?? null,
        createdById: user.id,
      }),
    );

    await this.audit.record(
      {
        action: 'automation.profile_created',
        resource: 'automation_profile',
        resourceId: profile.id,
        after: { name: profile.name, aiEnabled: profile.aiEnabled },
      },
      this.audit.actorFromRequest(request, user),
    );
    return profile;
  }

  @Patch('profiles/:id')
  @RequirePermissions('automation.approve')
  @ApiOperation({ summary: 'Edit a profile — affects every group assigned to it' })
  async updateProfile(
    @Param('id') id: string,
    @Body() dto: Partial<CreateProfileDto>,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const before = await this.profiles.findOneOrFail({ where: { id } });

    await this.profiles.update(id, {
      ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
      ...(dto.aiEnabled !== undefined ? { aiEnabled: dto.aiEnabled } : {}),
      ...(dto.automationEnabled !== undefined ? { automationEnabled: dto.automationEnabled } : {}),
      ...(dto.knowledgeProfileId !== undefined ? { knowledgeProfileId: dto.knowledgeProfileId } : {}),
      ...(dto.autoReplyMinConfidence !== undefined
        ? { autoReplyMinConfidence: String(dto.autoReplyMinConfidence) }
        : {}),
      ...(dto.escalateBelowConfidence !== undefined
        ? { escalateBelowConfidence: String(dto.escalateBelowConfidence) }
        : {}),
      ...(dto.midConfidencePolicy !== undefined ? { midConfidencePolicy: dto.midConfidencePolicy } : {}),
      ...(dto.humanTakeoverMinutes !== undefined ? { humanTakeoverMinutes: dto.humanTakeoverMinutes } : {}),
      ...(dto.assignedTeamId !== undefined ? { assignedTeamId: dto.assignedTeamId } : {}),
      updatedById: user.id,
    });

    const after = await this.profiles.findOneOrFail({ where: { id } });

    await this.audit.record(
      {
        action: 'automation.profile_updated',
        resource: 'automation_profile',
        resourceId: id,
        before: { aiEnabled: before.aiEnabled, automationEnabled: before.automationEnabled },
        after: { aiEnabled: after.aiEnabled, automationEnabled: after.automationEnabled },
      },
      this.audit.actorFromRequest(request, user),
    );
    return after;
  }
}
