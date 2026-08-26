import { ConversationResolverService } from './conversation-resolver.service';
import { ConversationKind, ConversationStatus } from './conversation-states';
import type { Conversation } from './entities/conversation.entity';
import type { Group } from '../groups/entities/group.entity';
import type { ChannelAccount } from '../channel/entities/channel-account.entity';

/**
 * Outbound conversation resolution.
 *
 * An operator messaging a destination for the first time is the moment that conversation begins.
 * Before this existed the message reached WhatsApp and was logged with no conversation, so it never
 * appeared in the inbox — the send looked like it had vanished.
 *
 * The properties that matter, and why each is tested:
 *
 *  * **Deterministic.** Repeated sends to one destination must land in one conversation, or the
 *    inbox grows a duplicate row per message.
 *  * **Race-safe.** Two sends at once must not create two conversations. The unique index on
 *    (channelAccountId, externalConversationId) is the arbiter; the resolver has to catch 23505 and
 *    re-read rather than propagate it.
 *  * **Correctly typed.** A group filed as DIRECT loses its group linkage — and a one-to-one filed
 *    as GROUP would be worse. Group-ness is decided by the synced `groups` table, never by the shape
 *    of the id, because that keeps the CRM layer channel-neutral.
 */

const ACCOUNT = { id: 'acct-1', channelKey: 'whatsapp' } as ChannelAccount;

const GROUP_JID = '120363409595499558@g.us';
const USER_JID = '8801711111111@c.us';

interface Harness {
  service: ConversationResolverService;
  saved: Array<Partial<Conversation>>;
  findCalls: number;
}

/**
 * Builds the resolver over in-memory repositories.
 *
 * Hand-rolled rather than a Nest testing module: this exercises one method's branching, and a full
 * DI container would add a great deal of setup without testing anything more.
 */
function harness(options: { group?: Group | null; existing?: Conversation | null; conflictOnce?: boolean } = {}): Harness {
  const saved: Array<Partial<Conversation>> = [];
  let conflictArmed = options.conflictOnce ?? false;
  let stored: Conversation | null = options.existing ?? null;
  let findCalls = 0;

  const conversations = {
    findOne: jest.fn(async () => {
      findCalls += 1;
      return stored;
    }),
    findOneOrFail: jest.fn(async () => {
      if (!stored) throw new Error('no conversation to return');
      return stored;
    }),
    create: (input: Partial<Conversation>) => input as Conversation,
    save: jest.fn(async (input: Partial<Conversation>) => {
      if (conflictArmed) {
        // Simulates the other send winning the insert race.
        conflictArmed = false;
        stored = { ...(input as Conversation), id: 'c-winner' };
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      }
      const row = { ...(input as Conversation), id: `c-${saved.length + 1}` };
      saved.push(row);
      stored = row;
      return row;
    }),
    update: jest.fn(async () => undefined),
    increment: jest.fn(async () => undefined),
  };

  const groups = { findOne: jest.fn(async () => options.group ?? null) };

  const service = new ConversationResolverService(
    conversations as never,
    { findOne: jest.fn(), save: jest.fn() } as never,
    { findOne: jest.fn(), save: jest.fn() } as never,
    { findOne: jest.fn() } as never,
    groups as never,
    { emitConversationEvent: jest.fn() } as never,
    { increment: jest.fn() } as never,
  );

  return { service, saved, get findCalls() { return findCalls; } } as Harness;
}

const syncedGroup = { id: 'g-1', name: 'Auto SMS Test Group', externalId: GROUP_JID } as Group;

describe('resolveForOutbound', () => {
  it('creates a GROUP conversation when the destination is a synced group', async () => {
    const h = harness({ group: syncedGroup });

    const { conversation, created } = await h.service.resolveForOutbound(ACCOUNT, GROUP_JID);

    expect(created).toBe(true);
    expect(conversation.kind).toBe(ConversationKind.GROUP);
    expect(conversation.groupId).toBe('g-1');
    expect(conversation.externalConversationId).toBe(GROUP_JID);
    // Named from the group, so the inbox does not show a raw JID.
    expect(conversation.subject).toBe('Auto SMS Test Group');
    expect(conversation.status).toBe(ConversationStatus.OPEN);
  });

  it('creates a DIRECT conversation for a destination that is not a group', async () => {
    const h = harness({ group: null });

    const { conversation } = await h.service.resolveForOutbound(ACCOUNT, USER_JID);

    expect(conversation.kind).toBe(ConversationKind.DIRECT);
    expect(conversation.groupId).toBeNull();
    // A conversation existing is not evidence of who it belongs to.
    expect(conversation.customerId).toBeNull();
  });

  it('never attributes an outbound conversation to a customer', async () => {
    // Sending to a number says nothing about whose number it is. Promotion stays a human act.
    const h = harness({ group: null });
    const { conversation } = await h.service.resolveForOutbound(ACCOUNT, USER_JID);
    expect(conversation.customerId).toBeNull();
  });

  it('returns the existing conversation instead of creating a second one', async () => {
    const existing = {
      id: 'c-existing',
      kind: ConversationKind.GROUP,
      groupId: 'g-1',
      externalConversationId: GROUP_JID,
      channelAccountId: 'acct-1',
    } as Conversation;
    const h = harness({ group: syncedGroup, existing });

    const first = await h.service.resolveForOutbound(ACCOUNT, GROUP_JID);
    const second = await h.service.resolveForOutbound(ACCOUNT, GROUP_JID);

    expect(first.created).toBe(false);
    expect(second.created).toBe(false);
    expect(first.conversation.id).toBe('c-existing');
    expect(second.conversation.id).toBe('c-existing');
    // Nothing was inserted on either pass.
    expect(h.saved).toHaveLength(0);
  });

  it('resolves to one conversation when two sends race the insert', async () => {
    // The loser of the race gets 23505 and must re-read the winner's row, not blow up and not
    // create a duplicate.
    const h = harness({ group: syncedGroup, conflictOnce: true });

    const { conversation, created } = await h.service.resolveForOutbound(ACCOUNT, GROUP_JID);

    expect(created).toBe(false);
    expect(conversation.id).toBe('c-winner');
  });

  it('records an outbound message without reopening a resolved conversation', async () => {
    // Our own message must not drag a closed issue back open — only a customer reply does that.
    const h = harness({ group: syncedGroup });
    const conversation = { id: 'c-1', status: ConversationStatus.RESOLVED } as Conversation;

    const reopened = await h.service.recordActivity(conversation, {
      at: new Date(),
      inbound: false,
      fromCustomer: false,
    });

    expect(reopened).toBeNull();
  });

  it('still reopens a resolved conversation when the customer replies', async () => {
    // The inbound rule must be unchanged by the outbound work.
    const h = harness({ group: syncedGroup });
    const conversation = { id: 'c-1', status: ConversationStatus.RESOLVED } as Conversation;

    const reopened = await h.service.recordActivity(conversation, {
      at: new Date(),
      inbound: true,
      fromCustomer: true,
    });

    expect(reopened).toBe(ConversationStatus.OPEN);
  });
});
