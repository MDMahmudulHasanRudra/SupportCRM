import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AppLogger } from '../../common/logging/app-logger';
import { MetricsService } from '../../common/metrics/metrics.service';
import {
  AutomationStatus,
  RuleOrigin,
  RuleScopeType,
  type RuleAction,
  type RuleConditionSet,
} from './automation-types';
import { AutomationRule } from './entities/automation-rule.entity';
import { AutomationRuleVersion } from './entities/automation-rule-version.entity';
import { RuleEvaluator } from './rule-evaluator';

/**
 * Authoring, approval and history for rules (`PROJECT_SPEC.md` §199; brief §24).
 *
 * The lifecycle mirrors Phase 4's knowledge lifecycle rather than inventing a second one, for the
 * same reason: what a customer is exposed to should only change when a person with the authority to
 * approve it says so.
 *
 * **Editing an ACTIVE rule returns it to DRAFT.** That is deliberate and is the whole point of an
 * approval workflow — otherwise a live rule's behaviour changes the moment somebody saves, with no
 * review in between.
 */

const ALLOWED_TRANSITIONS: Record<AutomationStatus, AutomationStatus[]> = {
  [AutomationStatus.DRAFT]: [AutomationStatus.REVIEW, AutomationStatus.ACTIVE, AutomationStatus.ARCHIVED],
  [AutomationStatus.REVIEW]: [AutomationStatus.DRAFT, AutomationStatus.ACTIVE, AutomationStatus.ARCHIVED],
  [AutomationStatus.ACTIVE]: [AutomationStatus.PAUSED, AutomationStatus.DRAFT, AutomationStatus.ARCHIVED],
  [AutomationStatus.PAUSED]: [AutomationStatus.ACTIVE, AutomationStatus.DRAFT, AutomationStatus.ARCHIVED],
  [AutomationStatus.ARCHIVED]: [AutomationStatus.DRAFT],
};

export interface RuleInput {
  name: string;
  description?: string | null;
  profileId?: string | null;
  priority?: number;
  scopeType?: RuleScopeType;
  scopeId?: string | null;
  conditions: RuleConditionSet;
  actions: RuleAction[];
  cooldownSeconds?: number;
  maxExecutions?: number | null;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  origin?: RuleOrigin;
}

@Injectable()
export class AutomationRuleService {
  private readonly logger = new AppLogger(AutomationRuleService.name);

  constructor(
    @InjectRepository(AutomationRule) private readonly rules: Repository<AutomationRule>,
    @InjectRepository(AutomationRuleVersion) private readonly versions: Repository<AutomationRuleVersion>,
    private readonly evaluator: RuleEvaluator,
    private readonly dataSource: DataSource,
    private readonly metrics: MetricsService,
  ) {}

  async findOne(id: string): Promise<AutomationRule> {
    const rule = await this.rules.findOne({ where: { id } });
    if (!rule) throw new NotFoundException(`Automation rule ${id} not found`);
    return rule;
  }

  async list(options: {
    status?: AutomationStatus;
    scopeType?: RuleScopeType;
    scopeId?: string;
    profileId?: string;
    limit?: number;
    offset?: number;
  }) {
    const [items, total] = await this.rules.findAndCount({
      where: {
        ...(options.status ? { status: options.status } : {}),
        ...(options.scopeType ? { scopeType: options.scopeType } : {}),
        ...(options.scopeId ? { scopeId: options.scopeId } : {}),
        ...(options.profileId ? { profileId: options.profileId } : {}),
      },
      order: { priority: 'DESC', createdAt: 'ASC' },
      take: Math.min(options.limit ?? 50, 200),
      skip: options.offset ?? 0,
    });
    return { items, total };
  }

  /**
   * Creates a rule, always as a DRAFT.
   *
   * A rule that could be born ACTIVE would let anybody with write access put words in front of
   * customers without review — including, later, the AI suggestion path (brief §25).
   */
  async create(input: RuleInput, userId: string | null): Promise<AutomationRule> {
    this.validate(input);

    const rule = await this.rules.save(
      this.rules.create({
        name: input.name.trim(),
        description: input.description ?? null,
        profileId: input.profileId ?? null,
        status: AutomationStatus.DRAFT,
        currentVersion: 1,
        priority: input.priority ?? 0,
        scopeType: input.scopeType ?? RuleScopeType.GLOBAL,
        scopeId: input.scopeId ?? null,
        conditions: input.conditions,
        actions: input.actions,
        cooldownSeconds: input.cooldownSeconds ?? 0,
        maxExecutions: input.maxExecutions ?? null,
        effectiveFrom: input.effectiveFrom ?? null,
        effectiveUntil: input.effectiveUntil ?? null,
        origin: input.origin ?? RuleOrigin.HUMAN,
        createdById: userId,
        updatedById: userId,
      }),
    );

    await this.snapshot(rule, 'Created', userId);
    this.metrics.increment('automation.rule_created', { origin: rule.origin });
    return rule;
  }

  async update(id: string, input: Partial<RuleInput>, userId: string | null): Promise<AutomationRule> {
    const rule = await this.findOne(id);

    const conditions = input.conditions ?? rule.conditions;
    const actions = input.actions ?? rule.actions;
    this.validate({ ...rule, ...input, conditions, actions } as RuleInput);

    const behaviourChanged =
      JSON.stringify(conditions) !== JSON.stringify(rule.conditions) ||
      JSON.stringify(actions) !== JSON.stringify(rule.actions);

    // Editing what a live rule DOES sends it back for approval. Editing its name or description
    // does not — that would make housekeeping needlessly disruptive.
    const demoted = behaviourChanged && rule.status === AutomationStatus.ACTIVE;

    await this.rules.update(id, {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.scopeType !== undefined ? { scopeType: input.scopeType } : {}),
      ...(input.scopeId !== undefined ? { scopeId: input.scopeId } : {}),
      ...(input.profileId !== undefined ? { profileId: input.profileId } : {}),
      ...(input.cooldownSeconds !== undefined ? { cooldownSeconds: input.cooldownSeconds } : {}),
      ...(input.maxExecutions !== undefined ? { maxExecutions: input.maxExecutions } : {}),
      ...(input.effectiveFrom !== undefined ? { effectiveFrom: input.effectiveFrom } : {}),
      ...(input.effectiveUntil !== undefined ? { effectiveUntil: input.effectiveUntil } : {}),
      conditions,
      actions,
      ...(behaviourChanged ? { currentVersion: rule.currentVersion + 1 } : {}),
      ...(demoted ? { status: AutomationStatus.DRAFT, approvedById: null, approvedAt: null } : {}),
      updatedById: userId,
    });

    const updated = await this.findOne(id);
    if (behaviourChanged) {
      await this.snapshot(updated, demoted ? 'Edited — returned to draft' : 'Edited', userId);
    }
    return updated;
  }

  /** Moves a rule through the lifecycle. Activation is the transition that exposes customers. */
  async transition(
    id: string,
    to: AutomationStatus,
    userId: string | null,
    note?: string,
  ): Promise<AutomationRule> {
    const rule = await this.findOne(id);
    if (rule.status === to) return rule;

    if (!ALLOWED_TRANSITIONS[rule.status].includes(to)) {
      throw new ConflictException(`A rule cannot go from ${rule.status} to ${to}`);
    }

    if (to === AutomationStatus.ACTIVE) {
      // Re-validate at activation. A rule may have been saved before a validation rule existed, or
      // edited through a path that skipped it; the moment it becomes live is the last safe place to
      // catch that.
      const problems = this.evaluator.validate(rule.conditions, rule.actions);
      if (problems.length > 0) {
        throw new BadRequestException(`This rule cannot be activated: ${problems.join(' ')}`);
      }
    }

    await this.rules.update(id, {
      status: to,
      ...(to === AutomationStatus.ACTIVE ? { approvedById: userId, approvedAt: new Date() } : {}),
      updatedById: userId,
    });

    const updated = await this.findOne(id);
    await this.snapshot(updated, note ?? `Status changed to ${to}`, userId);

    this.metrics.increment('automation.rule_transition', { to });
    this.logger.log('Automation rule status changed', { ruleId: id, from: rule.status, to });
    return updated;
  }

  async listVersions(id: string): Promise<AutomationRuleVersion[]> {
    await this.findOne(id);
    return this.versions.find({ where: { ruleId: id }, order: { version: 'DESC' } });
  }

  /**
   * Restores an earlier version as a new DRAFT version.
   *
   * A new version rather than a deletion, and a draft rather than straight back to live — the same
   * reasoning as knowledge rollback: history is evidence, and re-exposing old behaviour to
   * customers is a decision somebody should make deliberately.
   */
  async rollback(id: string, toVersion: number, userId: string | null): Promise<AutomationRule> {
    const rule = await this.findOne(id);
    const target = await this.versions.findOne({ where: { ruleId: id, version: toVersion } });
    if (!target) throw new NotFoundException(`Version ${toVersion} of this rule does not exist`);

    const snapshot = target.snapshot as unknown as RuleInput;

    await this.rules.update(id, {
      name: snapshot.name,
      description: snapshot.description ?? null,
      priority: snapshot.priority ?? 0,
      scopeType: snapshot.scopeType ?? RuleScopeType.GLOBAL,
      scopeId: snapshot.scopeId ?? null,
      conditions: snapshot.conditions,
      actions: snapshot.actions,
      cooldownSeconds: snapshot.cooldownSeconds ?? 0,
      maxExecutions: snapshot.maxExecutions ?? null,
      status: AutomationStatus.DRAFT,
      currentVersion: rule.currentVersion + 1,
      approvedById: null,
      approvedAt: null,
      updatedById: userId,
    });

    const updated = await this.findOne(id);
    await this.snapshot(updated, `Rolled back to v${toVersion}`, userId);
    return updated;
  }

  async remove(id: string): Promise<void> {
    await this.findOne(id);
    await this.rules.delete(id);
  }

  /** Structural validation plus scope integrity. Rejects at authoring time, not at match time. */
  private validate(input: RuleInput): void {
    const problems = this.evaluator.validate(input.conditions, input.actions);

    const scopeType = input.scopeType ?? RuleScopeType.GLOBAL;
    const scopeId = input.scopeId ?? null;

    if (scopeType === RuleScopeType.GLOBAL && scopeId) {
      problems.push('A global rule cannot be tied to a specific group, customer or conversation.');
    }
    if (scopeType !== RuleScopeType.GLOBAL && !scopeId) {
      problems.push(`A ${scopeType}-scoped rule needs the id it applies to.`);
    }
    if (!input.name?.trim()) problems.push('A rule needs a name.');

    if (problems.length > 0) throw new BadRequestException(problems.join(' '));
  }

  private async snapshot(rule: AutomationRule, changeSummary: string, userId: string | null): Promise<void> {
    await this.dataSource
      .createQueryBuilder()
      .insert()
      .into(AutomationRuleVersion)
      .values({
        ruleId: rule.id,
        version: rule.currentVersion,
        status: rule.status,
        snapshot: {
          name: rule.name,
          description: rule.description,
          priority: rule.priority,
          scopeType: rule.scopeType,
          scopeId: rule.scopeId,
          conditions: rule.conditions,
          actions: rule.actions,
          cooldownSeconds: rule.cooldownSeconds,
          maxExecutions: rule.maxExecutions,
        } as never,
        changeSummary: changeSummary.slice(0, 500),
        createdById: userId,
      })
      // Two edits racing on the same version number lose a snapshot, never an edit. The rule row is
      // the source of truth for the current version.
      .orIgnore()
      .execute();
  }
}
