import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { AppLogger } from '../../common/logging/app-logger';
import { MetricsService } from '../../common/metrics/metrics.service';
import { Group } from './entities/group.entity';
import { GroupOnboardingRule } from './entities/group-onboarding-rule.entity';

/**
 * What happens the first time a group is discovered (`PROJECT_SPEC.md` §98, §99, §134).
 *
 * At three thousand groups, "an administrator configures each new group" is not a workflow, it is a
 * backlog. A rule says *once* what a whole class of groups should look like — "anything with VIP in
 * the name gets the Premium profile and executive escalation" — and every group that arrives
 * afterwards is set up the moment it appears.
 *
 * Two properties this service is careful about:
 *
 *  * **Onboarding happens once.** `groups.onboardedAt` records it, and a group that has been
 *    through is never re-run. Otherwise the next group sync would quietly undo an operator's
 *    manual change and nobody would know why the setting kept reverting.
 *  * **It never switches automation on by itself unless a rule says so.** Discovering a group and
 *    starting to answer its customers are different events, and only one of them is a decision the
 *    system may make.
 */
@Injectable()
export class GroupOnboardingService {
  private readonly logger = new AppLogger(GroupOnboardingService.name);

  constructor(
    @InjectRepository(Group) private readonly groups: Repository<Group>,
    @InjectRepository(GroupOnboardingRule) private readonly rules: Repository<GroupOnboardingRule>,
    private readonly metrics: MetricsService,
  ) {}

  /** Active rules for an account, most specific first. Account-scoped rules beat global ones. */
  async rulesFor(channelAccountId: string): Promise<GroupOnboardingRule[]> {
    const rows = await this.rules.find({
      where: [
        { isActive: true, channelAccountId },
        { isActive: true, channelAccountId: IsNull() },
      ],
      order: { priority: 'ASC', createdAt: 'ASC' },
    });

    // An account-scoped rule outranks a global one at the same priority: it was written about
    // these groups specifically.
    return rows.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      const specificity = Number(Boolean(b.channelAccountId)) - Number(Boolean(a.channelAccountId));
      if (specificity !== 0) return specificity;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
  }

  /** The first rule whose name filter matches, or null. Pure given the rules. */
  match(group: Pick<Group, 'name'>, rules: GroupOnboardingRule[]): GroupOnboardingRule | null {
    const name = (group.name ?? '').toLowerCase();

    for (const rule of rules) {
      // A rule with no name filter is a catch-all, and matches anything on its account.
      if (!rule.nameContains) return rule;
      if (name.includes(rule.nameContains.toLowerCase())) return rule;
    }
    return null;
  }

  /**
   * Applies onboarding to groups that have not had it.
   *
   * Returns what happened per group so the caller can report it rather than claim a blanket
   * success. Called after a group sync, for the groups it created.
   */
  async onboard(groupIds: string[]): Promise<Array<{ groupId: string; ruleId: string | null; applied: boolean }>> {
    if (groupIds.length === 0) return [];

    const results: Array<{ groupId: string; ruleId: string | null; applied: boolean }> = [];

    // Both of these are hoisted out of the loop on purpose. A first sync onboards every group on
    // an account — three thousand of them at the stated scale — and fetching each group singly
    // while re-reading the rule set for each one is three queries per group. The groups come back
    // in one read, and the rules are read once per account and reused.
    const groups = await this.groups.find({ where: { id: In(groupIds) } });
    const rulesByAccount = new Map<string, GroupOnboardingRule[]>();

    for (const group of groups) {
      // Already done. Re-running would overwrite whatever an operator has since changed.
      if (group.onboardedAt) {
        results.push({ groupId: group.id, ruleId: group.onboardingRuleId ?? null, applied: false });
        continue;
      }

      let rules = rulesByAccount.get(group.channelAccountId);
      if (!rules) {
        rules = await this.rulesFor(group.channelAccountId);
        rulesByAccount.set(group.channelAccountId, rules);
      }

      const rule = this.match(group, rules);
      const groupId = group.id;

      const patch: Record<string, unknown> = {
        onboardedAt: new Date(),
        onboardingRuleId: rule?.id ?? null,
      };

      if (rule) {
        if (rule.automationProfileId) patch.automationProfileId = rule.automationProfileId;
        if (rule.knowledgeProfileId) patch.knowledgeProfileId = rule.knowledgeProfileId;
        if (rule.monitoringState) patch.monitoringState = rule.monitoringState;
        if (rule.automationEnabled !== null) patch.automationEnabled = rule.automationEnabled;
        if (rule.aiEnabled !== null) patch.aiEnabled = rule.aiEnabled;
        if (rule.escalationPolicy) patch.escalationPolicy = rule.escalationPolicy;

        await this.rules.update(rule.id, {
          matchCount: rule.matchCount + 1,
          lastMatchedAt: new Date(),
        });
      }

      await this.groups.update(groupId, patch);

      this.metrics.increment('groups.onboarded', { matched: String(Boolean(rule)) });
      results.push({ groupId, ruleId: rule?.id ?? null, applied: Boolean(rule) });
    }

    const matched = results.filter((result) => result.applied).length;
    if (results.length > 0) {
      this.logger.log('Group onboarding applied', {
        groups: results.length,
        matched,
        unmatched: results.length - matched,
      });
    }

    return results;
  }

  /**
   * What a rule would do to the groups that already exist, without doing it.
   *
   * The same discipline as the bulk preview: an operator writing a rule for three thousand groups
   * should see the blast radius before it is a fact.
   */
  async preview(rule: Pick<GroupOnboardingRule, 'nameContains' | 'channelAccountId'>): Promise<{
    total: number;
    sample: Array<{ id: string; name: string | null }>;
  }> {
    const query = this.groups.createQueryBuilder('g').where('g.isActive = true');

    if (rule.channelAccountId) {
      query.andWhere('g.channelAccountId = :accountId', { accountId: rule.channelAccountId });
    }
    if (rule.nameContains) {
      query.andWhere('LOWER(g.name) LIKE :needle', { needle: `%${rule.nameContains.toLowerCase()}%` });
    }

    const [rows, total] = await query.take(10).getManyAndCount();
    return { total, sample: rows.map((row) => ({ id: row.id, name: row.name })) };
  }
}
