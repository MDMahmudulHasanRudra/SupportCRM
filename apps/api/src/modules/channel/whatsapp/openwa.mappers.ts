import { ChannelConnectionState } from '../channel-connection';
import { NO_CAPABILITIES, type ChannelCapabilities } from '../channel-capabilities';
import {
  DeliveryStatus,
  MessageContentType,
  ParticipantRole,
} from '../../messaging/message-types';
import type {
  OpenWaDeliveryStatus,
  OpenWaGroupParticipant,
  OpenWaSessionStatus,
} from './openwa.contracts';

/**
 * Every translation between the gateway's vocabulary and ours, in one pure, testable file.
 *
 * These functions have no dependencies and no side effects, which is deliberate: mapping mistakes
 * are the most likely source of silent data corruption in an integration, and pure functions can be
 * exhaustively tested without a gateway, a database, or a network.
 *
 * The recurring rule: **an unrecognised provider value never becomes a plausible-looking default.**
 * It becomes an explicitly unknown/unsupported value that downstream code treats conservatively.
 */

/**
 * Gateway session status → our normalized connection state.
 *
 * `created` maps to DISCONNECTED, not CONNECTING: a created-but-never-started session is idle, and
 * reporting CONNECTING would leave the UI spinning forever waiting for a transition that no one
 * asked for.
 *
 * `action_required` maps to QR_REQUIRED because that is what it means in practice for this gateway
 * — the session needs a human to scan. If it ever also covers other interventions, this is the one
 * line that changes.
 */
export function mapSessionStatus(status: string | null | undefined): ChannelConnectionState {
  switch (status) {
    case 'created':
    case 'disconnected':
      return ChannelConnectionState.DISCONNECTED;
    case 'initializing':
    case 'authenticating':
      return ChannelConnectionState.CONNECTING;
    case 'qr_ready':
    case 'action_required':
      return ChannelConnectionState.QR_REQUIRED;
    case 'ready':
      return ChannelConnectionState.CONNECTED;
    case 'failed':
      return ChannelConnectionState.ERROR;
    default:
      // A status this adapter version does not know. UNKNOWN is honest and, crucially, is not
      // CONNECTED — so nothing will try to send on it.
      return ChannelConnectionState.UNKNOWN;
  }
}

/** Round-trip helper for tests and diagnostics; not used in the send path. */
export const KNOWN_SESSION_STATUSES: readonly OpenWaSessionStatus[] = [
  'created',
  'initializing',
  'qr_ready',
  'authenticating',
  'ready',
  'disconnected',
  'action_required',
  'failed',
];

/**
 * Gateway delivery signal → our normalized delivery status.
 *
 * The gateway's `pending` maps to SENDING, not QUEUED: it means the provider has accepted the
 * message and is working on it, which is strictly further along than sitting in our own queue.
 */
export function mapDeliveryStatus(status: string | null | undefined): DeliveryStatus | null {
  switch (status as OpenWaDeliveryStatus) {
    case 'pending':
      return DeliveryStatus.SENDING;
    case 'sent':
      return DeliveryStatus.SENT;
    case 'delivered':
      return DeliveryStatus.DELIVERED;
    case 'read':
      return DeliveryStatus.READ;
    case 'failed':
      return DeliveryStatus.FAILED;
    default:
      // null rather than a guess: an unmapped receipt must not move the delivery state at all.
      return null;
  }
}

/**
 * Gateway message type → our content type.
 *
 * The gateway passes the engine's own type string through, so this accepts both engines'
 * vocabularies. Anything unrecognised becomes UNSUPPORTED — the message is still persisted in full,
 * it is simply not claimed to be something it might not be.
 */
export function mapContentType(type: string | null | undefined): MessageContentType {
  switch ((type ?? '').toLowerCase()) {
    case 'chat':
    case 'text':
      return MessageContentType.TEXT;
    case 'image':
      return MessageContentType.IMAGE;
    case 'video':
      return MessageContentType.VIDEO;
    case 'audio':
    case 'ptt': // push-to-talk voice note
    case 'voice':
      return MessageContentType.AUDIO;
    case 'document':
      return MessageContentType.DOCUMENT;
    case 'sticker':
      return MessageContentType.STICKER;
    case 'location':
    case 'live_location':
      return MessageContentType.LOCATION;
    case 'vcard':
    case 'contact':
    case 'multi_vcard':
      return MessageContentType.CONTACT;
    case 'reaction':
      return MessageContentType.REACTION;
    case 'notification_template':
    case 'group_notification':
    case 'e2e_notification':
    case 'gp2':
    case 'call_log':
      return MessageContentType.SYSTEM_EVENT;
    default:
      return MessageContentType.UNSUPPORTED;
  }
}

/** Gateway participant flags → our role. Super-admin outranks admin. */
export function mapParticipantRole(participant: OpenWaGroupParticipant): ParticipantRole {
  if (participant.isSuperAdmin) return ParticipantRole.SUPER_ADMIN;
  if (participant.isAdmin) return ParticipantRole.ADMIN;
  return ParticipantRole.MEMBER;
}

/**
 * Capabilities of a connected WhatsApp account via this gateway.
 *
 * Derived from the endpoints the vendored OpenAPI actually exposes — not from what WhatsApp can do
 * in principle. Two are conditional and honestly reported:
 *
 *  - `canAddGroupMember` / `canRemoveGroupMember` / `canPromoteGroupMember` depend on the account
 *    being an admin of the specific group, which is not knowable at account level. They are
 *    reported true only when the account is connected, and the per-group check happens at call
 *    time — the API exists, but an individual call can still be refused.
 *  - `canReceiveReadStatus` is true because the gateway emits `message.ack` with a `read` status,
 *    which we verified in its source. It would be false for a channel that never reports reads.
 *
 * `canBroadcast` is false: the gateway's `send-bulk` endpoint exists but Support CRM deliberately
 * does not use it (`docs/adr/0001` §6) — broadcast goes through our own Job Center so it gets
 * audience preview, rate limiting, cancellation and per-recipient failures. Reporting `true` here
 * would advertise a path we refuse to take.
 */
export function whatsAppCapabilities(connected: boolean): ChannelCapabilities {
  if (!connected) return { ...NO_CAPABILITIES };

  return {
    canSendText: true,
    canSendMedia: true,
    canSendDocument: true,
    canReply: true,
    canReact: true,
    canEdit: true,
    canDelete: true,
    canPin: true,
    canReadGroupMembers: true,
    canAddGroupMember: true,
    canRemoveGroupMember: true,
    canPromoteGroupMember: true,
    canBroadcast: false,
    canReceiveDeliveryStatus: true,
    canReceiveReadStatus: true,
  };
}

/**
 * Extracts digits from a WhatsApp JID or raw number.
 *
 * A JID looks like `8801711223344@c.us`, a group like `12036…-16092…@g.us`, and a privacy id like
 * `…@lid`. Returns null rather than a partial string when there is nothing usable, so a caller
 * cannot accidentally treat a group id or an empty string as a phone number.
 *
 * Length-bounded: this parses untrusted input, and an unbounded regex over an attacker-supplied
 * string is how a cheap denial-of-service starts.
 */
export function extractPhone(jidOrNumber: string | null | undefined): string | null {
  if (!jidOrNumber) return null;
  const raw = jidOrNumber.slice(0, 128);

  const local = raw.includes('@') ? raw.split('@')[0] : raw;
  // A group JID's local part is `<creator>-<timestamp>`; that is not a phone number.
  if (local.includes('-')) return null;

  const digits = local.replace(/\D/g, '');
  // E.164 allows 7–15 digits. Anything outside that is not a phone number we should record.
  if (digits.length < 7 || digits.length > 15) return null;
  return digits;
}

/** True when the identifier is a group chat rather than a direct conversation. */
export function isGroupJid(jid: string | null | undefined): boolean {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

/**
 * The provider's timestamp, in seconds, converted to a Date.
 *
 * Falls back to now() only when the value is missing or implausible. Sanity bounds matter: a
 * message stamped in 1970 or in 2153 would corrupt every ordered query and every report that
 * touches it, and the value comes from outside our trust boundary.
 */
export function toDate(epochSeconds: number | null | undefined): Date {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds)) return new Date();
  const ms = epochSeconds * 1000;
  const year2000 = 946_684_800_000;
  const tenYearsAhead = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
  if (ms < year2000 || ms > tenYearsAhead) return new Date();
  return new Date(ms);
}
