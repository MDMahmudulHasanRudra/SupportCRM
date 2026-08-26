import type { ChannelKey } from './entities/channel.entity';
import type { ChannelCapabilities } from './channel-capabilities';
import type { ChannelConnectionState } from './channel-connection';
import type { DeliveryStatus, ParticipantRole } from '../messaging/message-types';
import type { VerifiedWebhook, WebhookAccountRef } from './webhook.types';

/**
 * The boundary between Support CRM and any messaging platform.
 *
 * `PROJECT_SPEC.md` §53–54 and `docs/adr/0001` §7–8: business logic must never call OpenWA (or
 * Meta, or anything else) directly. Every channel-specific concept — a gateway session id, a
 * WhatsApp JID, an `IncomingMessage` payload — stops at the adapter and is translated into the
 * neutral vocabulary below.
 *
 * Nothing in this file mentions WhatsApp or OpenWA. That is the test of whether the abstraction is
 * real: if adding Messenger later required changing this interface, the seam was in the wrong place.
 *
 * Phase 1 defines the contract and the registry. `WhatsAppChannelAdapter` (the OpenWA
 * implementation) arrives in Phase 2 — writing it now would mean writing it against an unverified
 * understanding of the gateway, which `docs/adr/0001` §2 explicitly forbids.
 */

/** Channel-neutral inbound message, normalised by the adapter. */
export interface NormalizedInboundMessage {
  /** The platform's own message id. Half of the idempotency key with `channelAccountId`. */
  externalId: string;
  channelAccountId: string;
  /** The platform's conversation/chat identifier. */
  externalConversationId: string;
  /** Set when the conversation is a group; null for a direct chat. */
  externalGroupId: string | null;
  /** Stable sender identity. In a group this is the participant, never the group itself. */
  senderExternalId: string;
  senderDisplayName: string | null;
  /** Best-effort E.164-ish phone number where the channel exposes one. */
  senderPhone: string | null;
  /**
   * Text, or a media caption. Null is a real, common value: an image sent with no caption has no
   * body at all, and coercing that to an empty string would make "no text" indistinguishable from
   * "text that happened to be blank".
   */
  body: string | null;
  messageType: InboundMessageType;
  /** Platform timestamp, converted to a real Date by the adapter. */
  sentAt: Date;
  /** True for messages the connected account itself sent — never automated on. */
  fromMe: boolean;
  quotedExternalId: string | null;
  mentionedExternalIds: string[];
  attachments: InboundAttachment[];
  /** Untranslated platform payload, for the decision inspector. Must contain no secrets. */
  raw: Record<string, unknown>;
}

export type InboundMessageType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contact'
  | 'reaction'
  | 'system'
  | 'unsupported';

export interface InboundAttachment {
  mimeType: string;
  filename: string | null;
  sizeBytes: number | null;
  /** True when the platform omitted the payload (too large, timed out). Not an error. */
  omitted: boolean;
}

export interface OutboundMessageRequest {
  channelAccountId: string;
  externalConversationId: string;
  body: string;
  /** Reply-to, where the channel supports it — gated on `canReply`. */
  quotedExternalId?: string | null;
  attachments?: OutboundAttachment[];
  /** Deduplicates at the adapter boundary as well as in the database (`PROJECT_SPEC.md` §117). */
  idempotencyKey: string;
}

export interface OutboundAttachment {
  mimeType: string;
  filename: string;
  /** Local path or storage key — never the bytes, so a queued job stays small. */
  storageRef: string;
  caption?: string;
}

export interface OutboundSendResult {
  /** The platform's id for the sent message, when it returns one synchronously. */
  externalId: string | null;
  /** What the channel actually reported. Never an invented status (`PROJECT_SPEC.md` §195). */
  status: 'sent' | 'queued' | 'failed';
  error?: string;
}

export interface ChannelAccountState {
  externalId: string;
  /** The normalized lifecycle from `channel-connection.ts` — never a provider's own vocabulary. */
  status: ChannelConnectionState;
  /**
   * What the account can do in THIS state.
   *
   * Carried on the state rather than fetched separately: the adapter already knows them when it
   * builds this object, and a second `getCapabilities()` call would mean a second gateway round
   * trip for information we just had. It also stops callers deriving capabilities themselves,
   * which would mean importing a provider-specific mapper.
   */
  capabilities: ChannelCapabilities;
  displayIdentity: string | null;
  /** The identity the account is paired to (a phone number for WhatsApp). Null until reported. */
  accountPhone?: string | null;
  /** Present only while pairing is required. Never logged, never audited. */
  pairingPayload?: string | null;
  lastError?: string | null;
}

/**
 * A delivery receipt, normalized. Null from the adapter means "unmappable" — never a guess, because
 * applying a wrong status would corrupt the delivery record permanently.
 */
export interface NormalizedDeliveryReceipt {
  externalMessageId: string;
  status: DeliveryStatus;
}

/** A connection-lifecycle event, normalized. `rawState` is kept only for diagnosis. */
export interface NormalizedConnectionEvent {
  state: ChannelConnectionState;
  rawState: string | null;
  detail: string | null;
}

/**
 * A pairing payload (a WhatsApp QR) extracted from a provider event.
 *
 * Credential-equivalent: whoever holds it can pair a device to the customer's account. It is
 * never persisted, never logged and never audited, and it reaches only the permission-gated
 * room described in `docs/WHATSAPP_UX_ARCHITECTURE.md` §5 — never the channel firehose.
 */
export interface PairingPayload {
  payload: string;
  /**
   * How `payload` should be presented.
   *
   * `image` — already a rendered `data:` image; display it as-is.
   * `text`  — the raw pairing string; the client encodes it into a QR itself.
   *
   * Which one a channel produces is the channel's business, and deciding it here rather than in the
   * browser keeps that knowledge inside the adapter where it belongs.
   */
  format: 'image' | 'text';
  /** When the channel will rotate it. Lets the UI show a countdown rather than a stale code. */
  expiresAt: Date;
}

export interface NormalizedGroup {
  externalId: string;
  name: string;
  description: string | null;
  memberCount: number | null;
}

/** One member of a group, normalized. */
export interface NormalizedParticipant {
  externalId: string;
  phone: string | null;
  displayName: string | null;
  role: ParticipantRole;
}

/** The detail call: everything the cheap listing endpoint does not return. */
export interface NormalizedGroupDetail {
  group: NormalizedGroup & { ownerExternalId: string | null; isAnnounceOnly: boolean };
  participants: NormalizedParticipant[];
}

/**
 * Implemented once per channel. Every method may throw `ChannelCapabilityError` when the connected
 * account does not support it — callers must not pre-suppose support.
 */
export interface ChannelAdapter {
  readonly channelKey: ChannelKey;
  /** Stable adapter identifier stored on `channels.adapterKey`, e.g. `openwa`. */
  readonly adapterKey: string;

  /** Probed on connect, never assumed. Stored on the account row. */
  getCapabilities(channelAccountId: string): Promise<ChannelCapabilities>;

  getAccountState(channelAccountId: string): Promise<ChannelAccountState>;
  connect(channelAccountId: string): Promise<ChannelAccountState>;
  disconnect(channelAccountId: string): Promise<void>;

  /**
   * Registers this account's inbound callback if it is missing, and reports whether one now exists.
   *
   * Optional: a channel that pushes without per-account registration has nothing to do here and
   * simply omits it.
   *
   * It exists because a connected session with no callback is a silent half-failure — messages send
   * perfectly and nothing ever arrives — and the condition can outlive the request that caused it.
   * Registration during connect can be lost to a gateway that was unreachable at the time, or to a
   * connect call that timed out while the session was still starting. Somewhere that runs
   * periodically has to notice and repair it, so this is callable from the maintenance sweep rather
   * than only from the connect path.
   */
  ensureInboundCallback?(
    channelAccountId: string,
    callbackUrl: string,
  ): Promise<{ registered: boolean; repaired: boolean }>;

  listGroups(
    channelAccountId: string,
    options?: { pageSize?: number; maxGroups?: number },
  ): Promise<NormalizedGroup[]>;

  /** Per-group detail, including participants. One call per group — hence a batched job. */
  getGroupDetail(channelAccountId: string, externalGroupId: string): Promise<NormalizedGroupDetail>;

  /**
   * Sends. The ONLY method that emits anything to a customer, and it is called exclusively by the
   * outbound layer after its pre-send re-validation (`PROJECT_SPEC.md` §194) — never by the
   * decision engine (§161).
   */
  send(request: OutboundMessageRequest): Promise<OutboundSendResult>;

  /**
   * Verifies an inbound webhook and normalises it. Returns an empty array for events this channel
   * delivers but Support CRM does not consume.
   *
   * Throws on a signature mismatch — an unverified webhook is not a message, it is an attack.
   */
  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<NormalizedInboundMessage[]>;

  /**
   * Interprets a stored, already-verified provider event.
   *
   * These three exist so the inbound worker never has to know a provider's event names, payload
   * shapes or status vocabulary. Without them the worker would import the gateway's types directly —
   * which is exactly the coupling `docs/adr/0001` §7 forbids, and which the ESLint boundary now
   * rejects.
   *
   * Each returns null when the event is not of that kind, or cannot be mapped.
   */
  /**
   * Reads just enough from an UNVERIFIED body to find which account's secret should verify it.
   *
   * Returns the channel's own account identifier, or null. Nothing else from this parse may be
   * trusted — at this point the body is attacker-controlled bytes.
   */
  identifyWebhookAccount(rawBody: Buffer): string | null;

  /**
   * Verifies a delivery against the account's own secret and decomposes it.
   *
   * Throws `WebhookVerificationError` on any failure. It never returns a partially-trusted
   * result: an unverified webhook is not a message, it is an attack.
   */
  verifyWebhook(
    account: WebhookAccountRef,
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<VerifiedWebhook>;

  /** Null when the payload is not a conversation message (a status broadcast, an unaddressable body). */
  normalizeInboundMessage(
    account: { id: string; channelKey: ChannelKey },
    envelope: { data: Record<string, unknown> },
  ): NormalizedInboundMessage | null;

  normalizeDeliveryReceipt(eventType: string, data: Record<string, unknown>): NormalizedDeliveryReceipt | null;

  normalizeConnectionEvent(eventType: string, data: Record<string, unknown>): NormalizedConnectionEvent | null;

  /**
   * Extracts a pairing payload from an event that carries one, or null.
   *
   * Separate from `normalizeConnectionEvent` on purpose: that method deliberately strips the
   * payload so ordinary event handling can never leak it, and this one exists for the single
   * caller that delivers it to an authorised operator.
   */
  extractPairingPayload(eventType: string, data: Record<string, unknown>): PairingPayload | null;
}
