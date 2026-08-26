/**
 * Channel-neutral message vocabulary.
 *
 * Nothing in this file names WhatsApp. Adapters map their provider's vocabulary onto these values,
 * and everything downstream — Phase 3's inbox, Phase 5's decision engine, Phase 6's AI — reads only
 * from here.
 */

export enum MessageDirection {
  INBOUND = 'INBOUND',
  OUTBOUND = 'OUTBOUND',
}

/**
 * What kind of content arrived (Phase 2 brief §6).
 *
 * `UNSUPPORTED` is a first-class value rather than an error: a channel will always eventually
 * deliver something this version does not model (a poll, a payment request, a new sticker format),
 * and the correct behaviour is to persist it faithfully as unsupported — never to drop it, and
 * never to mislabel it as text.
 */
export enum MessageContentType {
  TEXT = 'TEXT',
  IMAGE = 'IMAGE',
  VIDEO = 'VIDEO',
  AUDIO = 'AUDIO',
  DOCUMENT = 'DOCUMENT',
  STICKER = 'STICKER',
  LOCATION = 'LOCATION',
  CONTACT = 'CONTACT',
  REACTION = 'REACTION',
  /** Group joins/leaves/subject changes — an event about the conversation, not a message in it. */
  SYSTEM_EVENT = 'SYSTEM_EVENT',
  UNSUPPORTED = 'UNSUPPORTED',
}

/**
 * Who sent it, in support terms (Phase 2 brief §6).
 *
 * This becomes load-bearing later: Support Activity counts only `TEAM_MESSAGE`, and the Message
 * Decision Engine must never treat a `TEAM_MESSAGE` or a `BOT_MESSAGE` as a customer asking for
 * help — that is the primary automation loop guard.
 *
 * `UNKNOWN` is the honest default. A sender who is neither a configured team identity nor the
 * connected account itself is NOT automatically a customer: the brief (§8) is explicit that
 * customer identity is decided by the Phase 3 matching layer, not guessed here.
 */
export enum MessageClassification {
  /** From a participant who is not the account and not a known team identity. */
  CUSTOMER_MESSAGE = 'CUSTOMER_MESSAGE',
  /** From a phone mapped to a Support CRM user via `team_member_identities`. */
  TEAM_MESSAGE = 'TEAM_MESSAGE',
  /** Sent by the connected account itself — including everything Support CRM sent. */
  BOT_MESSAGE = 'BOT_MESSAGE',
  /** A group/system event rather than a person speaking. */
  SYSTEM_EVENT = 'SYSTEM_EVENT',
  UNKNOWN = 'UNKNOWN',
}

/** How far Support CRM has taken this message. */
export enum MessageProcessingStatus {
  PENDING = 'PENDING',
  PROCESSED = 'PROCESSED',
  /** Deliberately not processed — unowned account, unsupported type, or an ignore rule. */
  SKIPPED = 'SKIPPED',
  FAILED = 'FAILED',
}

/**
 * Normalized delivery lifecycle (Phase 2 brief §11).
 *
 * Ours, not the provider's. OpenWA reports `pending|sent|delivered|read|failed`; `QUEUED`,
 * `SENDING` and `CANCELLED` exist only inside Support CRM because they describe our own queue,
 * which no provider knows about.
 *
 * A channel that cannot report `READ` simply never produces it. `PROJECT_SPEC.md` §195 is explicit:
 * do not invent statuses a provider does not support.
 */
export enum DeliveryStatus {
  QUEUED = 'QUEUED',
  SENDING = 'SENDING',
  SENT = 'SENT',
  DELIVERED = 'DELIVERED',
  READ = 'READ',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

/**
 * Ordered so a late-arriving, weaker receipt cannot regress a stronger one.
 *
 * Delivery receipts are not ordered on the wire: a `delivered` ack can arrive after a `read` ack
 * for the same message. Comparing ranks before writing keeps the record monotonic.
 * `FAILED` and `CANCELLED` are terminal and sit above everything so nothing can overwrite them.
 */
const DELIVERY_RANK: Record<DeliveryStatus, number> = {
  [DeliveryStatus.QUEUED]: 0,
  [DeliveryStatus.SENDING]: 1,
  [DeliveryStatus.SENT]: 2,
  [DeliveryStatus.DELIVERED]: 3,
  [DeliveryStatus.READ]: 4,
  [DeliveryStatus.CANCELLED]: 5,
  [DeliveryStatus.FAILED]: 5,
};

/** True when `next` represents genuine forward progress from `current`. */
export function isDeliveryProgression(current: DeliveryStatus, next: DeliveryStatus): boolean {
  if (current === next) return false;
  // Terminal states are final. A stray `delivered` after a `failed` is noise, not news.
  if (current === DeliveryStatus.FAILED || current === DeliveryStatus.CANCELLED) return false;
  return DELIVERY_RANK[next] > DELIVERY_RANK[current];
}

/** Participant role within a group, normalized across channels. */
export enum ParticipantRole {
  MEMBER = 'MEMBER',
  ADMIN = 'ADMIN',
  SUPER_ADMIN = 'SUPER_ADMIN',
}

/**
 * What a group participant is to us (Phase 2 brief §8).
 *
 * Defaults to `UNKNOWN`, never to `CUSTOMER`. Deciding that every unrecognised participant is a
 * customer is exactly the assumption the brief forbids — Phase 3's matching layer makes that call.
 */
export enum ParticipantType {
  CUSTOMER = 'CUSTOMER',
  TEAM_MEMBER = 'TEAM_MEMBER',
  /** The connected account itself. */
  ACCOUNT = 'ACCOUNT',
  UNKNOWN = 'UNKNOWN',
}
