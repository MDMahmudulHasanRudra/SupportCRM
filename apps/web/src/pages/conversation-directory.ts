import type { Conversation, CustomerIdentity, WhatsAppGroup } from '../api/client';

/**
 * A place a message can be sent: a WhatsApp contact or a group.
 *
 * Built by merging three real sources — the group directory, the channel-identity directory, and
 * the conversations that already exist. A destination can exist with no conversation (nobody has
 * messaged yet) and a conversation can exist with no directory row (a number that arrived before
 * anything was synced), so both are carried and neither is hidden.
 */
export interface Destination {
  key: string;
  kind: 'USER' | 'GROUP';
  name: string;
  /** Phone number for a person, member count for a group. */
  subtitle: string;
  /** The channel's own id — the JID a message is addressed to. */
  externalId: string;
  /** Groups belong to one account. A contact identity does not, so the operator picks. */
  channelAccountId: string | null;
  groupId?: string;
  conversation?: Conversation;
  lastActivityAt: string | null;
}

export type DirectoryTab = 'all' | 'users' | 'groups';

/**
 * Merges the three sources into one addressable list.
 *
 * Kept pure and out of the component because the matching is the part that can quietly go wrong:
 * a group matched to the wrong conversation shows one chat's history under another's name, and a
 * conversation matched to nothing disappears from the inbox entirely. Both are silent failures, so
 * both are tested.
 *
 * Groups are matched on account **and** external id. A contact identity is channel-wide and carries
 * no account, so it matches on external id alone.
 */
export function buildDirectory(
  groups: WhatsAppGroup[],
  identities: CustomerIdentity[],
  conversations: Conversation[],
  tab: DirectoryTab = 'all',
): Destination[] {
  const scoped = new Map<string, Conversation>();
  const byExternal = new Map<string, Conversation>();

  for (const conversation of conversations) {
    scoped.set(`${conversation.channelAccountId}:${conversation.externalConversationId}`, conversation);
    // First writer wins: with two accounts in the same chat, the account-scoped key above is what
    // disambiguates, and this fallback only serves rows that carry no account.
    if (!byExternal.has(conversation.externalConversationId)) {
      byExternal.set(conversation.externalConversationId, conversation);
    }
  }

  const list: Destination[] = [];
  const claimed = new Set<string>();

  for (const group of groups) {
    const conversation = scoped.get(`${group.channelAccountId}:${group.externalId}`);
    if (conversation) claimed.add(conversation.id);

    list.push({
      key: `group:${group.id}`,
      kind: 'GROUP',
      name: group.name ?? 'Unnamed group',
      subtitle:
        group.participantCount === null || group.participantCount === undefined
          ? 'members not synced'
          : `${group.participantCount} member${group.participantCount === 1 ? '' : 's'}`,
      externalId: group.externalId,
      channelAccountId: group.channelAccountId,
      groupId: group.id,
      conversation,
      lastActivityAt: conversation?.lastMessageAt ?? group.lastMessageAt ?? null,
    });
  }

  for (const identity of identities) {
    const conversation = byExternal.get(identity.externalId);
    if (conversation) claimed.add(conversation.id);

    list.push({
      key: `identity:${identity.id}`,
      kind: 'USER',
      name: identity.displayName ?? identity.phone ?? identity.externalId,
      subtitle: identity.phone ?? identity.externalId,
      externalId: identity.externalId,
      channelAccountId: conversation?.channelAccountId ?? null,
      conversation,
      lastActivityAt: conversation?.lastMessageAt ?? identity.lastSeenAt ?? null,
    });
  }

  // A conversation with no directory row still has to be reachable — otherwise history quietly
  // disappears from the inbox just because a sync has not run.
  for (const conversation of conversations) {
    if (claimed.has(conversation.id)) continue;
    list.push({
      key: `conversation:${conversation.id}`,
      kind: conversation.kind === 'GROUP' ? 'GROUP' : 'USER',
      name: conversation.subject ?? conversation.externalConversationId,
      subtitle: conversation.kind === 'GROUP' ? 'group' : conversation.externalConversationId,
      externalId: conversation.externalConversationId,
      channelAccountId: conversation.channelAccountId,
      conversation,
      lastActivityAt: conversation.lastMessageAt,
    });
  }

  const filtered = list.filter((item) =>
    tab === 'all' ? true : tab === 'users' ? item.kind === 'USER' : item.kind === 'GROUP',
  );

  return filtered.sort((a, b) => {
    const pin=Number(Boolean(b.conversation?.isPinned))-Number(Boolean(a.conversation?.isPinned));
    if(pin) return pin;
    // Anything with activity outranks anything without; then newest first.
    if (a.lastActivityAt && b.lastActivityAt) return b.lastActivityAt.localeCompare(a.lastActivityAt);
    if (a.lastActivityAt) return -1;
    if (b.lastActivityAt) return 1;
    return a.name.localeCompare(b.name);
  });
}
