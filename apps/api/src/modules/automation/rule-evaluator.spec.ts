import {
  ActionType,
  AutomationStatus,
  ConditionType,
  RuleScopeType,
  SkipReason,
  type EvaluableRule,
  type EvaluationContext,
} from './automation-types';
import { RuleEvaluator, normalize } from './rule-evaluator';

/**
 * The rule evaluator.
 *
 * Pure, so every property that matters can be pinned down here without a database: which rule wins,
 * why it wins, and — the ones that would hurt a customer — which rules must never win.
 */

const NOW = new Date('2026-03-10T12:00:00Z');

function rule(overrides: Partial<EvaluableRule> = {}): EvaluableRule {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Test rule',
    status: AutomationStatus.ACTIVE,
    priority: 0,
    scopeType: RuleScopeType.GLOBAL,
    scopeId: null,
    version: 1,
    conditions: { match: 'ALL', conditions: [{ type: ConditionType.CONTAINS, value: 'internet' }] },
    actions: [{ type: ActionType.SEND_MESSAGE, value: 'We are looking into it.' }],
    cooldownSeconds: 0,
    maxExecutions: null,
    executionCount: 0,
    lastMatchedAt: null,
    effectiveFrom: null,
    effectiveUntil: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function context(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    body: 'my internet is down',
    messageType: 'TEXT',
    hasAttachment: false,
    conversationState: 'OPEN',
    customerTags: [],
    now: NOW,
    ...overrides,
  };
}

describe('RuleEvaluator — matching', () => {
  const evaluator = new RuleEvaluator();

  it('matches exact text after trimming', () => {
    const r = rule({ conditions: { match: 'ALL', conditions: [{ type: ConditionType.EXACT, value: 'hello' }] } });

    expect(evaluator.evaluate([r], context({ body: '  hello  ' })).winner).not.toBeNull();
    expect(evaluator.evaluate([r], context({ body: 'hello there' })).winner).toBeNull();
  });

  it('folds case and punctuation for a normalized match', () => {
    const r = rule({ conditions: { match: 'ALL', conditions: [{ type: ConditionType.NORMALIZED, value: 'hello' }] } });

    // "Hello!", "hello" and "  HELLO  " are the same greeting; a rule author should not have to
    // enumerate the variants.
    for (const body of ['Hello!', 'hello', '  HELLO  ', 'Hello.']) {
      expect(evaluator.evaluate([r], context({ body })).winner).not.toBeNull();
    }
  });

  it('matches contains, prefix and suffix', () => {
    const cases: Array<[ConditionType, string, string, boolean]> = [
      [ConditionType.CONTAINS, 'internet', 'my internet is down', true],
      [ConditionType.CONTAINS, 'billing', 'my internet is down', false],
      [ConditionType.PREFIX, 'my', 'my internet is down', true],
      [ConditionType.PREFIX, 'internet', 'my internet is down', false],
      [ConditionType.SUFFIX, 'down', 'my internet is down', true],
      [ConditionType.SUFFIX, 'my', 'my internet is down', false],
    ];

    for (const [type, value, body, expected] of cases) {
      const r = rule({ conditions: { match: 'ALL', conditions: [{ type, value }] } });
      expect(Boolean(evaluator.evaluate([r], context({ body })).winner)).toBe(expected);
    }
  });

  it('matches a regular expression', () => {
    const r = rule({
      conditions: { match: 'ALL', conditions: [{ type: ConditionType.REGEX, value: '^(hi|hello|hey)\\b' }] },
    });

    expect(evaluator.evaluate([r], context({ body: 'Hey there' })).winner).not.toBeNull();
    expect(evaluator.evaluate([r], context({ body: 'goodbye' })).winner).toBeNull();
  });

  it('treats a broken pattern as no match rather than throwing', () => {
    // A malformed rule must not throw inside the inbound path and take a customer message with it.
    const r = rule({ conditions: { match: 'ALL', conditions: [{ type: ConditionType.REGEX, value: '([unclosed' }] } });

    expect(() => evaluator.evaluate([r], context())).not.toThrow();
    expect(evaluator.evaluate([r], context()).winner).toBeNull();
  });

  it('negates a condition', () => {
    const r = rule({
      conditions: { match: 'ALL', conditions: [{ type: ConditionType.CONTAINS, value: 'billing', negate: true }] },
    });

    expect(evaluator.evaluate([r], context({ body: 'my internet is down' })).winner).not.toBeNull();
    expect(evaluator.evaluate([r], context({ body: 'a billing question' })).winner).toBeNull();
  });

  it('honours ALL versus ANY', () => {
    const conditions = [
      { type: ConditionType.CONTAINS, value: 'internet' },
      { type: ConditionType.CONTAINS, value: 'slow' },
    ];

    const all = rule({ conditions: { match: 'ALL', conditions } });
    const any = rule({ conditions: { match: 'ANY', conditions } });

    expect(evaluator.evaluate([all], context({ body: 'internet is down' })).winner).toBeNull();
    expect(evaluator.evaluate([any], context({ body: 'internet is down' })).winner).not.toBeNull();
    expect(evaluator.evaluate([all], context({ body: 'internet is slow' })).winner).not.toBeNull();
  });

  it('never matches a rule with no conditions', () => {
    // A rule with no conditions would answer every message. That is a mistake in the rule, and the
    // failure mode is bad enough that it must not be reachable by accident.
    const r = rule({ conditions: { match: 'ALL', conditions: [] } });
    expect(evaluator.evaluate([r], context()).winner).toBeNull();
  });

  it('matches on message type, attachment and conversation state', () => {
    const type = rule({
      conditions: { match: 'ALL', conditions: [{ type: ConditionType.MESSAGE_TYPE, values: ['IMAGE', 'VIDEO'] }] },
    });
    expect(evaluator.evaluate([type], context({ messageType: 'IMAGE' })).winner).not.toBeNull();
    expect(evaluator.evaluate([type], context({ messageType: 'TEXT' })).winner).toBeNull();

    const attachment = rule({
      conditions: { match: 'ALL', conditions: [{ type: ConditionType.HAS_ATTACHMENT }] },
    });
    expect(evaluator.evaluate([attachment], context({ hasAttachment: true })).winner).not.toBeNull();

    const state = rule({
      conditions: { match: 'ALL', conditions: [{ type: ConditionType.CONVERSATION_STATE, values: ['OPEN'] }] },
    });
    expect(evaluator.evaluate([state], context({ conversationState: 'OPEN' })).winner).not.toBeNull();
    expect(evaluator.evaluate([state], context({ conversationState: 'RESOLVED' })).winner).toBeNull();
  });

  it('does not match business hours when none are configured', () => {
    // "Are we open?" has no answer without configured hours, and a rule must not fire on a guess.
    const r = rule({ conditions: { match: 'ALL', conditions: [{ type: ConditionType.BUSINESS_HOURS }] } });
    expect(evaluator.evaluate([r], context({ businessHours: null })).winner).toBeNull();
  });

  it('handles a time window that wraps midnight', () => {
    const r = rule({
      conditions: { match: 'ALL', conditions: [{ type: ConditionType.TIME_WINDOW, from: '22:00', to: '06:00' }] },
    });

    const at = (hour: number) => {
      const date = new Date(NOW);
      date.setHours(hour, 0, 0, 0);
      return context({ now: date });
    };

    expect(evaluator.evaluate([r], at(23)).winner).not.toBeNull();
    expect(evaluator.evaluate([r], at(3)).winner).not.toBeNull();
    expect(evaluator.evaluate([r], at(12)).winner).toBeNull();
  });
});

describe('RuleEvaluator — choosing a winner', () => {
  const evaluator = new RuleEvaluator();

  it('ignores rules that are not ACTIVE', () => {
    for (const status of [
      AutomationStatus.DRAFT,
      AutomationStatus.REVIEW,
      AutomationStatus.PAUSED,
      AutomationStatus.ARCHIVED,
    ]) {
      // §199: only Published/Active automation executes. A draft answering a customer would defeat
      // the entire approval workflow.
      expect(evaluator.evaluate([rule({ status })], context()).winner).toBeNull();
    }
  });

  it('prefers a more specific scope over a higher priority', () => {
    const global = rule({ id: 'a'.repeat(8), scopeType: RuleScopeType.GLOBAL, priority: 1000, name: 'Global' });
    const group = rule({
      id: 'b'.repeat(8),
      scopeType: RuleScopeType.GROUP,
      scopeId: 'g1',
      priority: 0,
      name: 'Group',
    });

    // A rule written for one group should beat a global catch-all however high the catch-all's
    // priority — otherwise scope means nothing.
    expect(evaluator.evaluate([global, group], context()).winner?.rule.name).toBe('Group');
  });

  it('orders conversation over customer over group over global', () => {
    const rules = [
      rule({ id: '1'.repeat(8), scopeType: RuleScopeType.GLOBAL, name: 'global' }),
      rule({ id: '2'.repeat(8), scopeType: RuleScopeType.GROUP, scopeId: 'g', name: 'group' }),
      rule({ id: '3'.repeat(8), scopeType: RuleScopeType.CUSTOMER, scopeId: 'c', name: 'customer' }),
      rule({ id: '4'.repeat(8), scopeType: RuleScopeType.CONVERSATION, scopeId: 'v', name: 'conversation' }),
    ];

    expect(evaluator.evaluate(rules, context()).matches.map((m) => m.rule.name)).toEqual([
      'conversation',
      'customer',
      'group',
      'global',
    ]);
  });

  it('uses priority within a scope', () => {
    const low = rule({ id: 'a'.repeat(8), priority: 10, name: 'low' });
    const high = rule({ id: 'b'.repeat(8), priority: 100, name: 'high' });

    expect(evaluator.evaluate([low, high], context()).winner?.rule.name).toBe('high');
  });

  it('breaks a genuine tie by age, then by id — never randomly', () => {
    const older = rule({ id: 'z'.repeat(8), createdAt: new Date('2026-01-01'), name: 'older' });
    const newer = rule({ id: 'a'.repeat(8), createdAt: new Date('2026-02-01'), name: 'newer' });

    // Same scope, same priority. The order must be total and stable: running the same evaluation
    // twice on two replicas must not answer a customer differently.
    for (const order of [[older, newer], [newer, older]]) {
      expect(evaluator.evaluate(order, context()).winner?.rule.name).toBe('older');
    }

    const sameAge = [
      rule({ id: 'b'.repeat(8), createdAt: new Date('2026-01-01'), name: 'b' }),
      rule({ id: 'a'.repeat(8), createdAt: new Date('2026-01-01'), name: 'a' }),
    ];
    expect(evaluator.evaluate(sameAge, context()).winner?.rule.name).toBe('a');
  });

  it('records every match, not just the winner', () => {
    const rules = [
      rule({ id: '1'.repeat(8), priority: 10, name: 'first' }),
      rule({ id: '2'.repeat(8), priority: 5, name: 'second' }),
    ];

    const result = evaluator.evaluate(rules, context());
    // "Why that rule and not the other one?" has to be answerable afterwards.
    expect(result.matches.map((m) => m.rule.name)).toEqual(['first', 'second']);
  });
});

describe('RuleEvaluator — rules that match but may not act', () => {
  const evaluator = new RuleEvaluator();

  it('skips a rule inside its cooldown', () => {
    const r = rule({ cooldownSeconds: 600, lastMatchedAt: new Date(NOW.getTime() - 60_000) });
    const result = evaluator.evaluate([r], context());

    expect(result.winner).toBeNull();
    expect(result.matches[0].skipped).toBe(SkipReason.COOLDOWN);
  });

  it('lets the cooldown lapse', () => {
    const r = rule({ cooldownSeconds: 60, lastMatchedAt: new Date(NOW.getTime() - 120_000) });
    expect(evaluator.evaluate([r], context()).winner).not.toBeNull();
  });

  it('skips a rule that has spent its execution budget', () => {
    const r = rule({ maxExecutions: 5, executionCount: 5 });
    expect(evaluator.evaluate([r], context()).matches[0].skipped).toBe(SkipReason.MAX_EXECUTIONS);
  });

  it('respects an effective window', () => {
    const future = rule({ effectiveFrom: new Date(NOW.getTime() + 86_400_000) });
    const past = rule({ effectiveUntil: new Date(NOW.getTime() - 86_400_000) });

    expect(evaluator.evaluate([future], context()).matches[0].skipped).toBe(SkipReason.NOT_EFFECTIVE_YET);
    expect(evaluator.evaluate([past], context()).matches[0].skipped).toBe(SkipReason.EXPIRED);
  });

  it('lets a lower-ranked rule win when the best one is in cooldown', () => {
    // The customer still gets an answer. A cooled-down rule withholds itself, not the whole system.
    const cooling = rule({
      id: 'a'.repeat(8),
      priority: 100,
      name: 'cooling',
      cooldownSeconds: 600,
      lastMatchedAt: NOW,
    });
    const available = rule({ id: 'b'.repeat(8), priority: 10, name: 'available' });

    expect(evaluator.evaluate([cooling, available], context()).winner?.rule.name).toBe('available');
  });
});

describe('RuleEvaluator — validation', () => {
  const evaluator = new RuleEvaluator();

  it('rejects a rule with no conditions or no actions', () => {
    expect(evaluator.validate({ match: 'ALL', conditions: [] }, [{ type: ActionType.IGNORE }])).toContain(
      'A rule needs at least one condition, or it would match every message.',
    );
    expect(
      evaluator.validate({ match: 'ALL', conditions: [{ type: ConditionType.HAS_ATTACHMENT }] }, []),
    ).toContain('A rule needs at least one action.');
  });

  it('rejects an invalid pattern at authoring time', () => {
    const problems = evaluator.validate(
      { match: 'ALL', conditions: [{ type: ConditionType.REGEX, value: '([unclosed' }] },
      [{ type: ActionType.IGNORE }],
    );
    expect(problems.join(' ')).toMatch(/not valid/);
  });

  it('rejects a comparison with nothing to compare against', () => {
    const problems = evaluator.validate(
      { match: 'ALL', conditions: [{ type: ConditionType.CONTAINS, value: '   ' }] },
      [{ type: ActionType.IGNORE }],
    );
    expect(problems.join(' ')).toMatch(/needs a value/);
  });

  it('rejects a reply with no text', () => {
    const problems = evaluator.validate(
      { match: 'ALL', conditions: [{ type: ConditionType.HAS_ATTACHMENT }] },
      [{ type: ActionType.SEND_MESSAGE, value: '' }],
    );
    expect(problems.join(' ')).toMatch(/needs text to send/);
  });

  it('rejects two messages in one rule', () => {
    // Two sends for one inbound double-messages a customer, which is never what somebody means.
    const problems = evaluator.validate({ match: 'ALL', conditions: [{ type: ConditionType.HAS_ATTACHMENT }] }, [
      { type: ActionType.SEND_MESSAGE, value: 'one' },
      { type: ActionType.SEND_MESSAGE, value: 'two' },
    ]);
    expect(problems.join(' ')).toMatch(/at most one message/);
  });

  it('accepts a well-formed rule', () => {
    expect(
      evaluator.validate({ match: 'ALL', conditions: [{ type: ConditionType.CONTAINS, value: 'hello' }] }, [
        { type: ActionType.SEND_MESSAGE, value: 'Hi there' },
      ]),
    ).toEqual([]);
  });
});

describe('normalize', () => {
  it('folds case, punctuation and whitespace', () => {
    expect(normalize('  Hello,   World!  ')).toBe('hello world');
    expect(normalize('HELLO')).toBe(normalize('hello'));
  });
});
