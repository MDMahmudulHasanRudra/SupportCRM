import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { Allow, IsBoolean, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';
import type { Request } from 'express';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermissions } from '../rbac/permissions.guard';
import { GroupOnboardingRule } from './entities/group-onboarding-rule.entity';
import { GroupOnboardingService } from './group-onboarding.service';

export class OnboardingRuleDto {
  @IsString() @MinLength(1) @MaxLength(160) name!: string;
  @IsOptional() @IsString() @MaxLength(190) nameContains?: string;
  @IsOptional() @IsUUID() channelAccountId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) priority?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsUUID() automationProfileId?: string;
  @IsOptional() @IsUUID() knowledgeProfileId?: string;
  @IsOptional() @IsString() @MaxLength(16) monitoringState?: string;
  @IsOptional() @IsBoolean() automationEnabled?: boolean;
  @IsOptional() @IsBoolean() aiEnabled?: boolean;
  @IsOptional() @Allow() escalationPolicy?: Record<string, unknown>;
  @IsOptional() @IsUUID() notifyGroupId?: string;
}

/**
 * Onboarding rules for newly discovered groups (`PROJECT_SPEC.md` §98, §99, §134).
 *
 * At three thousand groups, configuring each new one by hand is a backlog rather than a workflow.
 * A rule says once what a class of groups should look like, and every group that appears afterwards
 * is set up the moment it is discovered.
 *
 * `preview` before `POST`, deliberately: a rule that matches more groups than its author expected
 * is the same failure mode as a bulk operation with a bad filter.
 */
@ApiTags('groups')
@Controller({ path: 'groups/onboarding-rules', version: '1' })
export class GroupOnboardingController {
  constructor(
    @InjectRepository(GroupOnboardingRule) private readonly rules: Repository<GroupOnboardingRule>,
    private readonly onboarding: GroupOnboardingService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('groups.read')
  @ApiOperation({ summary: 'Onboarding rules, in the order they are evaluated' })
  async list() {
    return { items: await this.rules.find({ order: { priority: 'ASC', createdAt: 'ASC' } }) };
  }

  @Post('preview')
  @RequirePermissions('groups.read')
  @ApiOperation({ summary: 'How many existing groups a rule would match, before saving it' })
  async preview(@Body() dto: OnboardingRuleDto) {
    return this.onboarding.preview({
      nameContains: dto.nameContains ?? null,
      channelAccountId: dto.channelAccountId ?? null,
    });
  }

  @Post()
  @RequirePermissions('groups.update')
  @ApiOperation({ summary: 'Add an onboarding rule' })
  async create(@Body() dto: OnboardingRuleDto, @CurrentUser() user: AuthenticatedUser, @Req() request: Request) {
    const rule = await this.rules.save(
      this.rules.create({
        name: dto.name.trim(),
        nameContains: dto.nameContains ?? null,
        channelAccountId: dto.channelAccountId ?? null,
        priority: dto.priority ?? 100,
        isActive: dto.isActive ?? true,
        automationProfileId: dto.automationProfileId ?? null,
        knowledgeProfileId: dto.knowledgeProfileId ?? null,
        monitoringState: dto.monitoringState ?? null,
        automationEnabled: dto.automationEnabled ?? null,
        aiEnabled: dto.aiEnabled ?? null,
        escalationPolicy: dto.escalationPolicy ?? null,
        notifyGroupId: dto.notifyGroupId ?? null,
        createdById: user.id,
      }),
    );

    await this.audit.record(
      {
        action: 'groups.onboarding_rule_created',
        resource: 'group_onboarding_rule',
        resourceId: rule.id,
        after: { name: rule.name, nameContains: rule.nameContains, priority: rule.priority },
      },
      this.audit.actorFromRequest(request, user),
    );
    return rule;
  }

  @Patch(':id')
  @RequirePermissions('groups.update')
  @ApiOperation({ summary: 'Edit an onboarding rule. Groups already onboarded are not revisited.' })
  async update(
    @Param('id') id: string,
    @Body() dto: Partial<OnboardingRuleDto>,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    await this.rules.update(id, {
      ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
      ...(dto.nameContains !== undefined ? { nameContains: dto.nameContains } : {}),
      ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      ...(dto.automationProfileId !== undefined ? { automationProfileId: dto.automationProfileId } : {}),
      ...(dto.monitoringState !== undefined ? { monitoringState: dto.monitoringState } : {}),
      ...(dto.automationEnabled !== undefined ? { automationEnabled: dto.automationEnabled } : {}),
      ...(dto.aiEnabled !== undefined ? { aiEnabled: dto.aiEnabled } : {}),
      // `as never`: TypeORM types a jsonb column update as a deep-partial and refuses an opaque
      // object. The shape is validated by the escalation policy merge, not by the column.
      ...(dto.escalationPolicy !== undefined ? { escalationPolicy: dto.escalationPolicy as never } : {}),
    });

    await this.audit.record(
      { action: 'groups.onboarding_rule_updated', resource: 'group_onboarding_rule', resourceId: id },
      this.audit.actorFromRequest(request, user),
    );
    return this.rules.findOneOrFail({ where: { id } });
  }

  @Delete(':id')
  @RequirePermissions('groups.update')
  @ApiOperation({ summary: 'Remove an onboarding rule' })
  async remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Req() request: Request) {
    await this.rules.delete(id);
    await this.audit.record(
      { action: 'groups.onboarding_rule_deleted', resource: 'group_onboarding_rule', resourceId: id },
      this.audit.actorFromRequest(request, user),
    );
    return { deleted: true };
  }
}
