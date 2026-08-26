import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { Allow, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import { AutomationCandidate, CandidateStatus } from '../automation/entities/automation-candidate.entity';
import { AutomationRule } from '../automation/entities/automation-rule.entity';
import { AutomationStatus, RuleScopeType } from '../automation/automation-types';
import { CurrentUser, RequirePermissions } from '../rbac/permissions.guard';
import { CandidateDetectorService } from './candidate-detector.service';

export class DetectDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) sinceDays?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class ReviewCandidateDto {
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  /** An edit before publishing. The whole point of review is that it can change what ships. */
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @Allow() conditions?: Record<string, unknown>;
  @IsOptional() @Allow() actions?: unknown[];
}

/**
 * The review queue for proposed automation (`PROJECT_SPEC.md` §85–§88, §135, §136).
 *
 * A candidate is a suggestion with evidence attached. Publishing one writes an ordinary automation
 * rule — as a **DRAFT**, which then needs the same approval every hand-written rule needs. That is
 * deliberate double friction: the system noticing a pattern and the system saying something to
 * customers are separated by two people, not one.
 *
 * An edit here changes the candidate before it is published. It never rewrites a live rule, and it
 * never touches production knowledge (§88).
 */
@ApiTags('automation')
@Controller({ path: 'automation/candidates', version: '1' })
export class CandidatesController {
  constructor(
    @InjectRepository(AutomationCandidate) private readonly candidates: Repository<AutomationCandidate>,
    @InjectRepository(AutomationRule) private readonly rules: Repository<AutomationRule>,
    private readonly detector: CandidateDetectorService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('automation.read')
  @ApiOperation({ summary: 'Proposed automation awaiting review, most evidenced first' })
  async list(@Query('status') status?: CandidateStatus) {
    const [items, total] = await this.candidates.findAndCount({
      where: status ? { status } : { status: CandidateStatus.PENDING },
      order: { occurrences: 'DESC', createdAt: 'DESC' },
      take: 100,
    });
    return { items, total };
  }

  @Post('detect')
  @RequirePermissions('automation.create')
  @ApiOperation({ summary: 'Look for repeated questions that needed a human, and propose rules' })
  async detect(@Body() dto: DetectDto) {
    return this.detector.detect({ sinceDays: dto.sinceDays, limit: dto.limit });
  }

  @Get(':id/evidence')
  @RequirePermissions('automation.read')
  @ApiOperation({ summary: 'The messages behind a candidate, so a reviewer can read them' })
  async evidence(@Param('id') id: string) {
    return { items: await this.detector.evidenceFor(id) };
  }

  @Post(':id/publish')
  @RequirePermissions('automation.approve')
  @ApiOperation({ summary: 'Turn a reviewed candidate into a DRAFT rule. It still needs activating.' })
  async publish(
    @Param('id') id: string,
    @Body() dto: ReviewCandidateDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const candidate = await this.candidates.findOne({ where: { id } });
    if (!candidate) throw new NotFoundException('That candidate does not exist.');
    if (candidate.status === CandidateStatus.PUBLISHED) {
      throw new BadRequestException('That candidate has already been published.');
    }

    const conditions = dto.conditions ?? candidate.proposedConditions;
    const actions = dto.actions ?? candidate.proposedActions;
    if (!conditions || !actions || (actions as unknown[]).length === 0) {
      throw new BadRequestException('A rule needs conditions and at least one action.');
    }

    // DRAFT, always. Publishing a candidate is the reviewer saying "this is worth considering",
    // not "start telling customers this" — that remains a separate approval (§86).
    const rule = await this.rules.save(
      this.rules.create({
        name: (dto.title ?? candidate.title).slice(0, 160),
        description: `Published from candidate: ${candidate.rationale ?? 'no rationale recorded'}`,
        status: AutomationStatus.DRAFT,
        scopeType: (candidate.scopeType as RuleScopeType) ?? RuleScopeType.GLOBAL,
        scopeId: candidate.scopeId,
        conditions: conditions as never,
        actions: actions as never,
        createdById: user.id,
      }),
    );

    await this.candidates.update(id, {
      status: CandidateStatus.PUBLISHED,
      publishedRuleId: rule.id,
      reviewedById: user.id,
      reviewedAt: new Date(),
      reviewNote: dto.note ?? null,
    });

    await this.audit.record(
      {
        action: 'automation.candidate_published',
        resource: 'automation_candidate',
        resourceId: id,
        after: { ruleId: rule.id, ruleStatus: rule.status, edited: Boolean(dto.conditions || dto.actions) },
      },
      this.audit.actorFromRequest(request, user),
    );

    return { candidateId: id, rule };
  }

  @Post(':id/reject')
  @RequirePermissions('automation.approve')
  @ApiOperation({ summary: 'Decline a candidate, with a reason' })
  async reject(
    @Param('id') id: string,
    @Body() dto: ReviewCandidateDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    await this.candidates.update(id, {
      status: CandidateStatus.REJECTED,
      reviewedById: user.id,
      reviewedAt: new Date(),
      reviewNote: dto.note ?? null,
    });

    await this.audit.record(
      { action: 'automation.candidate_rejected', resource: 'automation_candidate', resourceId: id },
      this.audit.actorFromRequest(request, user),
    );

    return this.candidates.findOneOrFail({ where: { id } });
  }
}
