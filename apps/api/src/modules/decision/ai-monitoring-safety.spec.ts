import { DecisionContextBuilder } from './decision-context';
import type { Conversation } from '../crm/entities/conversation.entity';
import type { Group } from '../groups/entities/group.entity';
import type { Message } from '../messaging/entities/message.entity';
import type { AutomationProfile } from '../automation/entities/automation-profile.entity';

/**
 * The AI monitoring permission chain.
 *
 * This is the safety rule the whole product rests on: **a group with AI monitoring off must never
 * receive an automated reply**, whatever else is true. Not when a rule matches, not when confidence
 * is high, not when the profile above it says yes.
 *
 * It is enforced in the backend, in `DecisionContextBuilder`, by composing the switches rather than
 * choosing between them — every level holds a veto. These tests pin that composition, because the
 * tempting "most specific wins" refactor would let a permissive profile switch a group's AI back on,
 * and the failure would be silent: customers in a group somebody deliberately muted start getting
 * machine replies, and nothing errors.
 *
 * The engine's own gate (`tryAi` → `AI_DISABLED`) is what turns `aiEnabled: false` into a recorded
 * non-answer; these tests cover the input to that decision.
 */

const conversation = (over: Partial<Conversation> = {}): Conversation =>
  ({ id: 'c1', aiEnabled: true, automationEnabled: true, ...over }) as Conversation;

const group = (over: Partial<Group> = {}): Group =>
  ({ id: 'g1', aiEnabled: true, automationEnabled: true, ...over }) as Group;

const profile = (over: Partial<AutomationProfile> = {}): AutomationProfile =>
  ({ id: 'p1', aiEnabled: true, automationEnabled: true, ...over }) as AutomationProfile;

const message = (groupId: string | null = 'g1'): Message => ({ id: 'm1', groupId }) as Message;

/**
 * Builds the context builder over stubbed repositories.
 *
 * Only the switch composition is under test, so rules and thresholds are stubbed to the empty case;
 * a full Nest container would add a great deal of setup and test none of this.
 */
function builder(options: { group?: Group | null; profile?: AutomationProfile | null } = {}) {
  const instance = new DecisionContextBuilder(
    { find: jest.fn(async () => []) } as never,
    { findOne: jest.fn(async () => options.profile ?? null) } as never,
    { findOne: jest.fn(async () => options.group ?? null) } as never,
    { get: jest.fn(async () => null), isStopped: jest.fn(async () => false) } as never,
  );

  // The profile and rule resolution paths are not what these tests are about.
  Object.assign(instance, {
    resolveProfile: async () => options.profile ?? null,
    loadRules: async () => [],
    resolveThresholds: async () => ({ autoReplyMin: 0.8, escalateBelow: 0.5, midPolicy: 'ESCALATE' }),
  });

  return instance;
}

describe('AI monitoring permission chain', () => {
  it('allows AI when every level permits it', async () => {
    const context = await builder({ group: group(), profile: profile() }).build(message(), conversation());
    expect(context.aiEnabled).toBe(true);
  });

  it('BLOCKS AI when the group has monitoring off — even with conversation and profile on', async () => {
    // The rule this file exists for.
    const context = await builder({
      group: group({ aiEnabled: false }),
      profile: profile({ aiEnabled: true }),
    }).build(message(), conversation({ aiEnabled: true }));

    expect(context.aiEnabled).toBe(false);
  });

  it('does not let a permissive profile switch a muted group back on', async () => {
    // The specific refactor that would break this: "most specific wins" instead of composition.
    const context = await builder({
      group: group({ aiEnabled: false }),
      profile: profile({ aiEnabled: true }),
    }).build(message(), conversation({ aiEnabled: true }));

    expect(context.aiEnabled).toBe(false);
  });

  it('BLOCKS AI when the conversation has it off, whatever the group says', async () => {
    const context = await builder({ group: group({ aiEnabled: true }) }).build(
      message(),
      conversation({ aiEnabled: false }),
    );
    expect(context.aiEnabled).toBe(false);
  });

  it('BLOCKS AI when the profile has it off', async () => {
    const context = await builder({ group: group(), profile: profile({ aiEnabled: false }) }).build(
      message(),
      conversation(),
    );
    expect(context.aiEnabled).toBe(false);
  });

  it('treats a direct chat with no group as neither permitting nor blocking', async () => {
    // A one-to-one conversation has no group. Absence must not read as `false`, or AI would be off
    // for every direct chat in the product.
    const context = await builder({ group: null }).build(message(null), conversation({ aiEnabled: true }));
    expect(context.aiEnabled).toBe(true);
  });

  it('applies the same composition to automation, independently of AI', async () => {
    // Message collection and automation are separate permissions from AI; a group may run
    // deterministic rules while being forbidden an AI reply, and the reverse.
    const context = await builder({
      group: group({ aiEnabled: false, automationEnabled: true }),
    }).build(message(), conversation());

    expect(context.aiEnabled).toBe(false);
    expect(context.automationEnabled).toBe(true);
  });

  it('blocks automation when the group withholds it while AI stays permitted', async () => {
    const context = await builder({
      group: group({ aiEnabled: true, automationEnabled: false }),
    }).build(message(), conversation());

    expect(context.aiEnabled).toBe(true);
    expect(context.automationEnabled).toBe(false);
  });
});
