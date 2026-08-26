import { describe, expect, it } from 'vitest';
import type { Conversation, CustomerIdentity, WhatsAppGroup } from '../api/client';
import { buildDirectory } from './conversation-directory';

/**
 * The inbox merge, tested because both of its failure modes are silent.
 *
 * Match a group to the wrong conversation and the operator reads one chat's history under another
 * chat's name. Match a conversation to nothing and it vanishes from the inbox entirely. Neither
 * throws, so neither would be noticed until somebody replied to the wrong person.
 */

const group = (over: Partial<WhatsAppGroup> = {}): WhatsAppGroup =>
  ({
    id: 'g1',
    externalId: '1203@g.us',
    channelAccountId: 'acct-1',
    name: 'ISP Support',
    description: null,
    participantCount: 87,
    isActive: true,
    monitoringState: 'MONITORED',
    lastSyncedAt: null,
    participantsSyncedAt: null,
    lastMessageAt: null,
    ...over,
  }) as WhatsAppGroup;

const identity = (over: Partial<CustomerIdentity> = {}): CustomerIdentity =>
  ({
    id: 'i1',
    channelKey: 'whatsapp',
    externalId: '8801711@c.us',
    phone: '8801711',
    displayName: 'Rahim',
    customerId: null,
    matchState: 'UNRESOLVED',
    lastSeenAt: null,
    ...over,
  }) as CustomerIdentity;

const conversation = (over: Partial<Conversation> = {}): Conversation =>
  ({
    id: 'c1',
    channelKey: 'whatsapp',
    channelAccountId: 'acct-1',
    externalConversationId: '1203@g.us',
    kind: 'GROUP',
    groupId: 'g1',
    customerId: null,
    subject: 'ISP Support',
    status: 'OPEN',
    priority: 'NORMAL',
    controlState: 'AUTOMATION_ACTIVE',
    aiEnabled: false,
    automationEnabled: false,
    pausedUntil: null,
    takeoverByUserId: null,
    takeoverReason: null,
    takeoverAt: null,
    assignedToUserId: null,
    assignedToTeamId: null,
    lastMessageAt: '2026-08-25T10:00:00.000Z',
    lastInboundAt: null,
    lastOutboundAt: null,
    messageCount: 3,
    isPinned: false,
    resolvedAt: null,
    specState: 'AUTOMATION_ACTIVE',
    createdAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-25T10:00:00.000Z',
    ...over,
  }) as Conversation;

describe('buildDirectory', () => {
  it('lists a group that has no conversation yet, so it can still be messaged', () => {
    const [only] = buildDirectory([group()], [], []);
    expect(only.kind).toBe('GROUP');
    expect(only.conversation).toBeUndefined();
    expect(only.externalId).toBe('1203@g.us');
    expect(only.subtitle).toBe('87 members');
    // The account is what a send needs; a group always carries one.
    expect(only.channelAccountId).toBe('acct-1');
  });

  it('attaches a conversation to its group by account and external id', () => {
    const [only] = buildDirectory([group()], [], [conversation()]);
    expect(only.conversation?.id).toBe('c1');
    expect(only.lastActivityAt).toBe('2026-08-25T10:00:00.000Z');
  });

  it('does not attach a conversation from a different account to the same chat id', () => {
    // Two WhatsApp accounts can both be in a chat with the same external id. Matching on the id
    // alone would show one account's history under the other's group.
    const rows = buildDirectory([group({ channelAccountId: 'acct-1' })], [], [
      conversation({ id: 'other', channelAccountId: 'acct-2' }),
    ]);
    // Select the group's own row by key — the orphan conversation below is also a GROUP kind, so
    // matching on kind alone would pick the wrong row and pass for the wrong reason.
    const groupRow = rows.find((r) => r.key === 'group:g1');
    expect(groupRow).toBeDefined();
    expect(groupRow?.conversation).toBeUndefined();
    // ...and the unmatched conversation must still appear, not vanish.
    expect(rows.some((r) => r.conversation?.id === 'other')).toBe(true);
  });

  it('surfaces a conversation that matches no directory row', () => {
    const rows = buildDirectory([], [], [conversation({ id: 'orphan', externalConversationId: 'unknown@c.us' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].conversation?.id).toBe('orphan');
    expect(rows[0].externalId).toBe('unknown@c.us');
  });

  it('does not duplicate a conversation that a group already claimed', () => {
    const rows = buildDirectory([group()], [], [conversation()]);
    expect(rows.filter((r) => r.conversation?.id === 'c1')).toHaveLength(1);
  });

  it('matches a contact identity on external id and inherits its account', () => {
    const rows = buildDirectory(
      [],
      [identity()],
      [conversation({ id: 'direct', kind: 'DIRECT', externalConversationId: '8801711@c.us', groupId: null })],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('USER');
    expect(rows[0].conversation?.id).toBe('direct');
    // A bare identity has no account of its own; it borrows the conversation's.
    expect(rows[0].channelAccountId).toBe('acct-1');
  });

  it('says so when a group has no synced member count rather than showing zero', () => {
    const [only] = buildDirectory([group({ participantCount: null })], [], []);
    expect(only.subtitle).toBe('members not synced');
  });

  it('orders by activity, and puts everything unused last', () => {
    const rows = buildDirectory(
      [
        group({ id: 'quiet', externalId: 'q@g.us', name: 'Quiet', lastMessageAt: null }),
        group({ id: 'busy', externalId: 'b@g.us', name: 'Busy', lastMessageAt: '2026-08-25T12:00:00.000Z' }),
        group({ id: 'older', externalId: 'o@g.us', name: 'Older', lastMessageAt: '2026-08-24T12:00:00.000Z' }),
      ],
      [],
      [],
    );
    expect(rows.map((r) => r.name)).toEqual(['Busy', 'Older', 'Quiet']);
  });

  it('filters to users or groups on request', () => {
    const rows = buildDirectory([group()], [identity()], []);
    expect(buildDirectory([group()], [identity()], [], 'users').every((r) => r.kind === 'USER')).toBe(true);
    expect(buildDirectory([group()], [identity()], [], 'groups').every((r) => r.kind === 'GROUP')).toBe(true);
    expect(rows).toHaveLength(2);
  });
});
