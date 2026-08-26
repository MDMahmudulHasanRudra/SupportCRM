import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MetricsService } from '../../common/metrics/metrics.service';
import { Group } from './entities/group.entity';
import { GroupOnboardingRule } from './entities/group-onboarding-rule.entity';
import { GroupOnboardingService } from './group-onboarding.service';

/**
 * Which onboarding rule claims a newly discovered group.
 *
 * The matcher is the part worth pinning: at three thousand groups an operator writes a handful of
 * rules and never inspects the result group by group, so "the wrong rule won" is a mistake that
 * stays invisible until a VIP customer gets the default profile.
 */
describe('group onboarding matching (§98, §99)', () => {
  let service: GroupOnboardingService;

  const rule = (over: Partial<GroupOnboardingRule>): GroupOnboardingRule =>
    ({
      id: over.id ?? 'rule',
      name: over.name ?? 'rule',
      nameContains: over.nameContains ?? null,
      channelAccountId: over.channelAccountId ?? null,
      priority: over.priority ?? 100,
      isActive: true,
      automationProfileId: over.automationProfileId ?? null,
      knowledgeProfileId: null,
      monitoringState: null,
      automationEnabled: null,
      aiEnabled: null,
      escalationPolicy: null,
      notifyGroupId: null,
      matchCount: 0,
      lastMatchedAt: null,
      createdById: null,
      createdAt: over.createdAt ?? new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
    }) as GroupOnboardingRule;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        GroupOnboardingService,
        { provide: getRepositoryToken(Group), useValue: {} },
        { provide: getRepositoryToken(GroupOnboardingRule), useValue: {} },
        { provide: MetricsService, useValue: { increment: () => undefined } },
      ],
    }).compile();

    service = moduleRef.get(GroupOnboardingService);
  });

  it('matches on a case-insensitive substring of the name', () => {
    const rules = [rule({ id: 'vip', nameContains: 'VIP' })];

    expect(service.match({ name: 'Dhaka VIP Customers' }, rules)?.id).toBe('vip');
    expect(service.match({ name: 'dhaka vip customers' }, rules)?.id).toBe('vip');
    expect(service.match({ name: 'Regular Customers' }, rules)).toBeNull();
  });

  it('returns the first matching rule, so priority order decides', () => {
    const rules = [
      rule({ id: 'specific', nameContains: 'VIP Platinum', priority: 10 }),
      rule({ id: 'broad', nameContains: 'VIP', priority: 50 }),
    ];

    expect(service.match({ name: 'VIP Platinum Dhaka' }, rules)?.id).toBe('specific');
    expect(service.match({ name: 'VIP Silver' }, rules)?.id).toBe('broad');
  });

  it('treats a rule with no name filter as a catch-all', () => {
    const rules = [rule({ id: 'vip', nameContains: 'VIP' }), rule({ id: 'default', nameContains: null })];

    expect(service.match({ name: 'VIP Dhaka' }, rules)?.id).toBe('vip');
    expect(service.match({ name: 'Anything Else' }, rules)?.id).toBe('default');
  });

  it('handles a group whose name is empty', () => {
    // `groups.name` is NOT NULL in the schema, so the empty string is the degenerate case that can
    // actually occur — a name filter must not claim it, and a catch-all still should.
    expect(service.match({ name: '' }, [rule({ id: 'vip', nameContains: 'VIP' })])).toBeNull();
    expect(service.match({ name: '' }, [rule({ id: 'any', nameContains: null })])?.id).toBe('any');
  });

  it('matches nothing when no rule applies, rather than falling back to the first', () => {
    const rules = [rule({ id: 'vip', nameContains: 'VIP' }), rule({ id: 'biz', nameContains: 'Business' })];
    expect(service.match({ name: 'Home Users Dhaka' }, rules)).toBeNull();
  });
});
