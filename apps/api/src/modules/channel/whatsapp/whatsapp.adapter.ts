import { ConflictException, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppLogger } from '../../../common/logging/app-logger';
import { CryptoService } from '../../../common/crypto/crypto.service';
import {
  assertCapability,
  normalizeCapabilities,
  type ChannelCapabilities,
} from '../channel-capabilities';
import { ChannelConnectionState } from '../channel-connection';
import { ChannelRegistryService } from '../channel-registry.service';
import { ChannelAccount } from '../entities/channel-account.entity';
import { ChannelKey } from '../entities/channel.entity';
import { MessageContentType } from '../../messaging/message-types';
import type {
  ChannelAccountState,
  ChannelAdapter,
  NormalizedConnectionEvent,
  NormalizedDeliveryReceipt,
  NormalizedGroup,
  NormalizedGroupDetail,
  NormalizedInboundMessage,
  PairingPayload,
  OutboundMessageRequest,
  OutboundSendResult,
} from '../channel-adapter.interface';
import { OpenWaClient, OpenWaError } from './openwa.client';
import {
  OPENWA_HEADERS,
  SUBSCRIBED_EVENTS,
  isSubscribedEvent,
  type OpenWaAckPayload,
  type OpenWaGroupDetail,
  type OpenWaIncomingMessage,
  type OpenWaWebhookEnvelope,
} from './openwa.contracts';
import {
  extractPhone,
  isGroupJid,
  mapContentType,
  mapDeliveryStatus,
  mapParticipantRole,
  mapSessionStatus,
  toDate,
  whatsAppCapabilities,
} from './openwa.mappers';
import { verifySignature, isWithinReplayWindow, SignatureFailure } from './openwa.signature';
import {
  WebhookRejectionReason,
  WebhookVerificationError,
  type VerifiedWebhook,
  type WebhookAccountRef,
} from '../webhook.types';

/**
 * Gateway statuses that mean "this session is doing something useful".
 *
 * Used to decide whether a failed `POST /start` actually failed. `disconnected`, `created` and
 * `failed` are absent on purpose — those mean the start genuinely did not take.
 */
const LIVE_SESSION_STATUSES = new Set(['initializing', 'authenticating', 'qr_ready', 'ready', 'action_required']);

/**
 * How long a WhatsApp QR stays valid.
 *
 * WhatsApp rotates it roughly every 20 seconds. The gateway does not tell us when, so this is
 * the window the UI counts down against; a slightly pessimistic value is right, because showing
 * "expired, waiting for a new one" a moment early is better than showing a dead code.
 */
const QR_ROTATION_MS = 20_000;

/** Hard cap on a persisted message body. An unbounded body is a cheap DoS on every consumer. */
export const MAX_BODY_LENGTH = 16_000;
/** Hard cap on how many mentions we will record from one message. */
const MAX_MENTIONS = 256;

/** Maps this adapter's signature failures onto the neutral rejection vocabulary. */
const SIGNATURE_REASON: Record<SignatureFailure, WebhookRejectionReason> = {
  [SignatureFailure.MISSING_SECRET]: WebhookRejectionReason.MISSING_SECRET,
  [SignatureFailure.MISSING_SIGNATURE]: WebhookRejectionReason.MISSING_SIGNATURE,
  [SignatureFailure.MALFORMED_SIGNATURE]: WebhookRejectionReason.MALFORMED_SIGNATURE,
  [SignatureFailure.MISMATCH]: WebhookRejectionReason.MISMATCH,
};

/**
 * The WhatsApp implementation of `ChannelAdapter`.
 *
 * Together with `OpenWaClient`, this is the boundary. Everything above it speaks in
 * `channelAccountId`, `externalConversationId` and `NormalizedInboundMessage`; everything below it
 * speaks in sessions, chat ids and JIDs. Nothing crosses in either direction untranslated.
 *
 * The class does not touch `messages`, `groups` or any domain table. It reads `channel_accounts`
 * because that is where the session identity and the webhook secret live — its own configuration,
 * not domain data.
 */
@Injectable()
export class WhatsAppChannelAdapter implements ChannelAdapter, OnModuleInit {
  readonly channelKey = ChannelKey.WHATSAPP;
  readonly adapterKey = 'openwa';

  private readonly logger = new AppLogger(WhatsAppChannelAdapter.name);

  constructor(
    private readonly client: OpenWaClient,
    private readonly crypto: CryptoService,
    private readonly registry: ChannelRegistryService,
    @InjectRepository(ChannelAccount) private readonly accounts: Repository<ChannelAccount>,
  ) {}

  onModuleInit(): void {
    // Explicit registration: the set of live adapters stays greppable, and a half-finished adapter
    // cannot activate itself merely by existing on disk.
    this.registry.register(this);
  }

  // === session lifecycle ====================================================================

  async getAccountState(channelAccountId: string): Promise<ChannelAccountState> {
    const account = await this.loadAccount(channelAccountId);

    // No gateway session yet is a normal state, not an error: the account row records the
    // operator's intent before connect() has created anything.
    if (!account.externalId) {
      return {
        externalId: '',
        status: ChannelConnectionState.DISCONNECTED,
        capabilities: whatsAppCapabilities(false),
        displayIdentity: null,
        accountPhone: null,
        lastError: 'No gateway session has been created for this account yet',
      };
    }

    try {
      const session = await this.client.getSession(account.externalId);
      return this.toAccountState(session.id, session.status, session);
    } catch (error) {
      // 400 as well as 404: the gateway answers 400 "uuid is expected" for a malformed id and
      // 404 for a well-formed one it does not know. Both mean the same thing to us — there is
      // no live session — and treating only 404 as such is what broke Phase 2.
      if (error instanceof OpenWaError && (error.status === 404 || error.status === 400)) {
        // The gateway has never heard of this session. DISCONNECTED, not ERROR: the row is simply
        // ahead of the gateway, which is the normal state right after registering an account.
        return {
          externalId: account.externalId ?? '',
          status: ChannelConnectionState.DISCONNECTED,
          capabilities: whatsAppCapabilities(false),
          displayIdentity: null,
          accountPhone: null,
          lastError: 'No such session on the gateway yet',
        };
      }
      throw error;
    }
  }

  /**
   * Starts the session, creating it on the gateway if it does not exist yet.
   *
   * Returns as soon as the gateway accepts. It does NOT wait for CONNECTED — pairing needs a human
   * to scan a QR code, which can take minutes, and blocking an HTTP request on that would tie up a
   * worker for the duration (Phase 2 brief §10).
   */
  async connect(channelAccountId: string): Promise<ChannelAccountState> {
    const account = await this.loadAccount(channelAccountId);
    const sessionId = await this.ensureGatewaySession(account);

    try {
      const session = await this.client.startSession(sessionId);
      return this.toAccountState(session.id, session.status, session);
    } catch (error) {
      // `POST /start` can fail while the session is nonetheless fine. Two cases, both observed
      // against the real gateway:
      //
      //  * `400 "Session is already started"` — the caller asked for a running session and there is
      //    one. Treating that as a failure made connect non-idempotent, so a retried or
      //    double-clicked connect broke an otherwise healthy session.
      //  * `504` — the gateway's own engine-init timeout elapsed while Chromium was still starting.
      //    The session still reaches `qr_ready` moments later.
      //
      // In both cases the HTTP result is a worse description of reality than the session itself, so
      // ask the session. The contract stub answered instantly and always succeeded, which is why
      // neither case could surface before a real gateway was involved.
      const state = await this.client.getSession(sessionId).catch(() => null);

      if (state && LIVE_SESSION_STATUSES.has(state.status)) {
        this.logger.warn('start returned an error but the session is live; reporting the real state', {
          channelAccountId,
          gatewayStatus: state.status,
          error: error instanceof Error ? error.message : String(error),
        });
        return this.toAccountState(state.id, state.status, state);
      }

      throw error;
    }
  }

  /**
   * Resolves this account to a live gateway session id, creating the session if needed.
   *
   * Find-or-create by NAME, because the name is what the operator chose and the id is what the
   * gateway assigns. Three cases, all real:
   *  - we already know the id and the gateway still has it → use it;
   *  - we do not know it, but a session with our name exists (a previous connect stored nothing,
   *    or the gateway was rebuilt) → adopt its id rather than colliding on the name;
   *  - neither → create it.
   *
   * Creating with a duplicate name answers 409, so adopting first is not an optimisation — it is
   * what keeps a retried connect from failing outright.
   */
  private async ensureGatewaySession(account: ChannelAccount): Promise<string> {
    if (account.externalId) {
      try {
        await this.client.getSession(account.externalId);
        return account.externalId;
      } catch (error) {
        if (!(error instanceof OpenWaError) || (error.status !== 404 && error.status !== 400)) throw error;
        // The stored id is stale (gateway rebuilt, session deleted). Fall through and re-resolve.
        this.logger.warn('Stored gateway session id is no longer valid; re-resolving by name', {
          channelAccountId: account.id,
        });
      }
    }

    const existing = (await this.client.listSessions()).find((s) => s.name === account.externalName);
    const sessionId = existing
      ? existing.id
      : (await this.client.createSession(account.externalName)).id;

    await this.accounts.update(account.id, { externalId: sessionId });
    account.externalId = sessionId;
    return sessionId;
  }

  /**
   * Stops the session without logging out — the paired device is preserved, so reconnecting does
   * not need another QR scan. Logging out is a separate, deliberately un-exposed action: it
   * destroys the pairing, and doing that by accident on a production account is expensive.
   */
  async disconnect(channelAccountId: string): Promise<void> {
    const account = await this.loadAccount(channelAccountId);
    await this.client.stopSession(this.gatewaySessionId(account));
  }

  /** Explicit unlink; callers must enforce confirmation, permissions and recovery intent. */
  async logout(channelAccountId: string): Promise<void> {
    const account = await this.loadAccount(channelAccountId);
    await this.client.logoutSession(this.gatewaySessionId(account));
  }

  /**
   * The QR payload for pairing.
   *
   * Returned to the caller and nothing else: never persisted, never logged, never audited. Anyone
   * holding it can pair a device to the customer's WhatsApp account, which makes it strictly
   * credential-equivalent.
   */
  async getPairingPayload(channelAccountId: string): Promise<{ qr: string | null; state: ChannelConnectionState }> {
    const account = await this.loadAccount(channelAccountId);

    try {
      const response = await this.client.getQr(this.gatewaySessionId(account));
      return { qr: response.qrCode ?? null, state: mapSessionStatus(response.status) };
    } catch (error) {
      // "No code right now" is an ordinary answer, not a failure. The gateway says it with a 4xx —
      // 400 once the session is authenticated ("no QR code needed"), 404 before the engine has
      // produced one — and a client that polls while a dialog is open would otherwise turn every
      // one of those into a 500 and a stack trace in the log.
      if (error instanceof OpenWaError && (error.status === 400 || error.status === 404)) {
        return { qr: null, state: account.status as ChannelConnectionState };
      }
      throw error;
    }
  }

  async getCapabilities(channelAccountId: string): Promise<ChannelCapabilities> {
    return (await this.getAccountState(channelAccountId)).capabilities;
  }

  // === groups ================================================================================

  /**
   * Lists every group, paging through the gateway rather than asking for all of them at once.
   *
   * `PROJECT_SPEC.md` §119 targets 3,000+ groups and the brief §7 forbids loading them all into
   * memory unnecessarily. The gateway's listing endpoint is the cheap one — id and name only — so
   * this is safe to walk in full; participants come from a separate per-group call.
   *
   * `maxGroups` is a real backstop, not decoration: a gateway that ignored `offset` would otherwise
   * make this loop forever.
   */
  async listGroups(channelAccountId: string, options: { pageSize?: number; maxGroups?: number } = {}): Promise<NormalizedGroup[]> {
    const account = await this.loadAccount(channelAccountId);
    const pageSize = Math.min(Math.max(options.pageSize ?? 200, 1), 500);
    const maxGroups = options.maxGroups ?? 20_000;

    const collected: NormalizedGroup[] = [];
    const seen = new Set<string>();

    for (let offset = 0; collected.length < maxGroups; offset += pageSize) {
      const page = await this.client.listGroups(this.gatewaySessionId(account), pageSize, offset);
      if (!Array.isArray(page) || page.length === 0) break;

      for (const group of page) {
        // Guards against a gateway that ignores offset and replays page 1 forever.
        if (!group?.id || seen.has(group.id)) continue;
        seen.add(group.id);
        collected.push({
          externalId: group.id,
          name: sanitizeText(group.name, 255) ?? group.id,
          description: null,
          memberCount: null,
        });
      }

      if (page.length < pageSize) break;
    }

    return collected;
  }

  /** The detail call: description, owner, announce-only flag and the full participant list. */
  async getGroupDetail(
    channelAccountId: string,
    externalGroupId: string,
  ): Promise<NormalizedGroupDetail> {
    const account = await this.loadAccount(channelAccountId);
    const detail: OpenWaGroupDetail = await this.client.getGroup(
      this.gatewaySessionId(account),
      externalGroupId,
    );

    const participants = (detail.participants ?? [])
      .filter((p) => Boolean(p?.id))
      .map((p) => ({
        externalId: p.id,
        // `number` is the gateway's own field; fall back to parsing the JID when it is absent.
        phone: extractPhone(p.number) ?? extractPhone(p.id),
        displayName: sanitizeText(p.name, 190),
        role: mapParticipantRole(p),
      }));

    return {
      group: {
        externalId: detail.id,
        name: sanitizeText(detail.name, 255) ?? detail.id,
        description: sanitizeText(detail.description, 4000),
        memberCount: participants.length,
        ownerExternalId: detail.owner ?? null,
        // Both spellings appear in the gateway's own contract; either means members cannot post.
        isAnnounceOnly: Boolean(detail.isAnnounce ?? detail.announce),
      },
      participants,
    };
  }

  // === outbound ==============================================================================

  /**
   * The single place a WhatsApp message is actually emitted.
   *
   * Called exclusively by the outbound worker, after its pre-send re-validation. The decision
   * engine has no path here — it produces actions, and `MessageService` turns those into
   * `outbound_messages` rows (`PROJECT_SPEC.md` §161, brief §12).
   *
   * Capability is asserted before the call, not after a failure: a channel that cannot reply must
   * refuse the request rather than silently sending a non-reply the operator did not ask for.
   */
  async send(request: OutboundMessageRequest): Promise<OutboundSendResult> {
    const account = await this.loadAccount(request.channelAccountId);
    const capabilities = normalizeCapabilities(account.capabilities);

    try {
      const attachment = request.attachments?.[0];

      if (attachment) {
        assertCapability(capabilities, 'canSendMedia', account.id);
        const isDocument = !attachment.mimeType.startsWith('image/');
        if (isDocument) assertCapability(capabilities, 'canSendDocument', account.id);

        const payload = {
          chatId: request.externalConversationId,
          url: attachment.storageRef,
          mimetype: attachment.mimeType,
          filename: attachment.filename,
          caption: request.body ?? attachment.caption,
          quotedMessageId: request.quotedExternalId ?? undefined,
        };
        const result = isDocument
          ? await this.client.sendDocument(this.gatewaySessionId(account), payload)
          : await this.client.sendImage(this.gatewaySessionId(account), payload);
        return { externalId: result.messageId, status: 'sent' };
      }

      assertCapability(capabilities, 'canSendText', account.id);

      if (request.quotedExternalId) {
        assertCapability(capabilities, 'canReply', account.id);
        const result = await this.client.reply(this.gatewaySessionId(account), {
          chatId: request.externalConversationId,
          quotedMessageId: request.quotedExternalId,
          text: request.body ?? '',
        });
        return { externalId: result.messageId, status: 'sent' };
      }

      const result = await this.client.sendText(this.gatewaySessionId(account), {
        chatId: request.externalConversationId,
        text: request.body ?? '',
      });
      return { externalId: result.messageId, status: 'sent' };
    } catch (error) {
      if (error instanceof OpenWaError) {
        return {
          externalId: null,
          status: 'failed',
          // The gateway's body is included for diagnosis. It never contains our API key — that
          // travels in a header the gateway does not echo.
          error: `Gateway rejected the send (${error.status}): ${error.body.slice(0, 500)}`,
        };
      }
      throw error;
    }
  }

  // === webhook ===============================================================================

  /**
   * `ChannelAdapter.parseWebhook`. Present so the interface stays honest, but ingestion uses
   * {@link verifyWebhook} plus {@link normalizeInboundMessage} instead, because it needs the
   * envelope's idempotency key BEFORE deciding whether to normalize anything at all.
   */
  async parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<NormalizedInboundMessage[]> {
    const sessionId = this.identifyWebhookAccount(rawBody);
    if (!sessionId) throw new WebhookVerificationError(WebhookRejectionReason.MALFORMED_BODY);

    const account = await this.accounts.findOne({
      where: { channelKey: ChannelKey.WHATSAPP, externalId: sessionId },
    });
    if (!account) throw new WebhookVerificationError(WebhookRejectionReason.UNKNOWN_ACCOUNT);

    const verified = await this.verifyWebhook(account, rawBody, headers);
    if (!verified.consumed || verified.eventType !== 'message.received') return [];

    const normalized = this.normalizeInboundMessage(
      account,
      verified.payload as { data: Record<string, unknown> },
    );
    return normalized ? [normalized] : [];
  }

  /**
   * Verifies a delivery against the account's own HMAC secret.
   *
   * Order matters and is not arbitrary: signature first, then replay window, then shape. Parsing an
   * unverified body means running a JSON parser on attacker-controlled bytes before any
   * authentication has happened, and the envelope is only trustworthy once the HMAC has held.
   */
  async verifyWebhook(
    account: WebhookAccountRef,
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<VerifiedWebhook> {
    const secret = this.decryptWebhookSecret(account);

    const signature = verifySignature(rawBody, headers[OPENWA_HEADERS.SIGNATURE], secret);
    if (!signature.valid) throw new WebhookVerificationError(SIGNATURE_REASON[signature.reason]);

    let envelope: OpenWaWebhookEnvelope;
    try {
      envelope = JSON.parse(rawBody.toString('utf8')) as OpenWaWebhookEnvelope;
    } catch {
      throw new WebhookVerificationError(WebhookRejectionReason.MALFORMED_BODY);
    }

    if (!envelope || typeof envelope !== 'object' || typeof envelope.event !== 'string') {
      throw new WebhookVerificationError(WebhookRejectionReason.MALFORMED_BODY);
    }
    // The signature covers the timestamp, so it cannot be altered without breaking the HMAC —
    // which is exactly what makes it usable as a freshness bound.
    if (!isWithinReplayWindow(envelope.timestamp)) {
      throw new WebhookVerificationError(WebhookRejectionReason.REPLAY_WINDOW);
    }
    // A body whose sessionId disagrees with the account whose secret verified it would mean one
    // session's secret being used to inject events into another. Signed or not, refuse it.
    if (envelope.sessionId && envelope.sessionId !== account.externalId) {
      throw new WebhookVerificationError(WebhookRejectionReason.MALFORMED_BODY);
    }

    const header = (name: string): string | null => {
      const value = headers[name];
      const single = Array.isArray(value) ? value[0] : value;
      return single ? single.slice(0, 190) : null;
    };

    return {
      payload: envelope as unknown as Record<string, unknown>,
      // Prefer the header, fall back to the signed body. Both are covered by the signature path:
      // the body is signed, and a forged header cannot change the body the HMAC was computed over.
      providerIdempotencyKey:
        header(OPENWA_HEADERS.IDEMPOTENCY_KEY) ??
        envelope.idempotencyKey ??
        `${envelope.event}:${envelope.sessionId}:${envelope.timestamp}`,
      providerDeliveryId: header(OPENWA_HEADERS.DELIVERY_ID) ?? envelope.deliveryId ?? null,
      providerRetryCount: Number(header(OPENWA_HEADERS.RETRY_COUNT) ?? 0) || 0,
      eventType: envelope.event,
      consumed: isSubscribedEvent(envelope.event),
    };
  }

  /**
   * Turns a verified `message.received` / `message.sent` envelope into our neutral shape.
   *
   * Returns null for anything that is not a real conversation message — a status/story broadcast,
   * or a payload missing the fields that make a message addressable. Returning null rather than
   * throwing is deliberate: these are normal, expected deliveries, not errors.
   *
   * Every string here is attacker-controlled and is sanitised and length-capped on the way in.
   */
  normalizeInboundMessage(
    account: { id: string; channelKey: ChannelKey },
    envelope: { data: Record<string, unknown> },
  ): NormalizedInboundMessage | null {
    const data = envelope?.data as unknown as OpenWaIncomingMessage;
    if (!data || typeof data !== 'object') return null;
    if (typeof data.id !== 'string' || !data.id) return null;
    if (typeof data.chatId !== 'string' || !data.chatId) return null;
    // Status/story broadcasts are not conversations and must never enter the message log.
    if (data.isStatusBroadcast) return null;

    const isGroup = Boolean(data.isGroup) || isGroupJid(data.chatId);

    // In a group the gateway puts the GROUP jid in `from` and the real sender in `author`.
    // Getting this backwards would attribute every group message to the group itself — which would
    // then classify every one of them identically and break Support Activity outright.
    const senderExternalId = isGroup ? (data.author ?? data.from) : data.from;
    if (typeof senderExternalId !== 'string' || !senderExternalId) return null;

    const contentType = mapContentType(data.type);

    const attachments = data.media
      ? [
          {
            mimeType: sanitizeMimeType(data.media.mimetype),
            filename: sanitizeFilename(data.media.filename),
            sizeBytes: clampSize(data.media.sizeBytes),
            omitted: Boolean(data.media.omitted),
          },
        ]
      : [];

    return {
      externalId: data.id,
      channelAccountId: account.id,
      externalConversationId: data.chatId,
      externalGroupId: isGroup ? data.chatId : null,
      senderExternalId,
      senderDisplayName:
        sanitizeText(data.contact?.pushname ?? data.contact?.name ?? data.contact?.shortName, 190),
      // `senderPhone` is only populated by the gateway for privacy-id senders; fall back to parsing
      // the JID, which is the ordinary case.
      senderPhone: extractPhone(data.senderPhone) ?? extractPhone(senderExternalId),
      body: sanitizeText(data.body, MAX_BODY_LENGTH),
      messageType: contentTypeToInbound(contentType),
      sentAt: toDate(data.timestamp),
      fromMe: Boolean(data.fromMe),
      quotedExternalId: data.quotedMessage?.id ?? null,
      mentionedExternalIds: Array.isArray(data.mentionedIds)
        ? data.mentionedIds.filter((m): m is string => typeof m === 'string').slice(0, MAX_MENTIONS)
        : [],
      attachments,
      // A bounded, non-sensitive summary for the decision inspector — deliberately NOT the whole
      // payload, which is retained under its own policy on `provider_events`.
      raw: {
        type: data.type,
        kind: data.kind,
        isGroup,
        hasMedia: Boolean(data.media),
        isLidSender: Boolean(data.isLidSender),
        ephemeralDuration: data.ephemeralDuration ?? null,
      },
    };
  }

  /**
   * Translates a `message.ack` payload into a neutral delivery receipt.
   *
   * Returns null for a different event type, a missing message id, or a status this adapter cannot
   * map — an unmappable receipt must not move the delivery state at all.
   */
  normalizeDeliveryReceipt(
    eventType: string,
    data: Record<string, unknown>,
  ): NormalizedDeliveryReceipt | null {
    if (eventType !== 'message.ack') return null;

    const ack = data as unknown as OpenWaAckPayload;
    const externalMessageId = ack?.messageId ?? ack?.id;
    const status = mapDeliveryStatus(ack?.status);

    if (typeof externalMessageId !== 'string' || !externalMessageId || !status) return null;
    return { externalMessageId, status };
  }

  /**
   * Translates a `session.*` event into a neutral connection event.
   *
   * `session.qr` deliberately reports only the STATE. Its payload carries the QR itself, which is
   * credential-equivalent — it is never persisted, never logged, and never leaves this method.
   */
  normalizeConnectionEvent(
    eventType: string,
    data: Record<string, unknown>,
  ): NormalizedConnectionEvent | null {
    switch (eventType) {
      case 'session.qr':
        return { state: ChannelConnectionState.QR_REQUIRED, rawState: 'session.qr', detail: null };

      case 'session.authenticated':
        return {
          state: mapSessionStatus((data?.status as string) ?? 'ready'),
          rawState: (data?.status as string) ?? eventType,
          detail: null,
        };

      case 'session.disconnected':
        return {
          state: mapSessionStatus((data?.status as string) ?? 'disconnected'),
          rawState: (data?.status as string) ?? eventType,
          detail: typeof data?.reason === 'string' ? data.reason.slice(0, 500) : null,
        };

      case 'session.status':
        return {
          state: mapSessionStatus(data?.status as string),
          rawState: (data?.status as string) ?? eventType,
          detail: typeof data?.reason === 'string' ? data.reason.slice(0, 500) : null,
        };

      default:
        return null;
    }
  }

  /**
   * Extracts the QR from a `session.qr` event.
   *
   * WhatsApp rotates the code roughly every 20 seconds and the gateway emits a fresh event each
   * time, so Support CRM never generates or refreshes a QR itself — it relays what arrives and
   * stamps the rotation window so the UI can count down instead of showing a dead code.
   */
  extractPairingPayload(eventType: string, data: Record<string, unknown>): PairingPayload | null {
    if (eventType !== 'session.qr') return null;

    // The gateway names the field `qr`; accept `qrCode` too, which its REST endpoint uses.
    const raw = (data?.qr ?? data?.qrCode) as unknown;
    if (typeof raw !== 'string' || raw.length < 8) return null;

    return {
      payload: raw,
      // This gateway renders the code to a PNG before sending it; older builds and other engines
      // emit the raw pairing string. Both are supported rather than assuming either.
      format: raw.startsWith('data:image') ? 'image' : 'text',
      expiresAt: new Date(Date.now() + QR_ROTATION_MS),
    };
  }

  /**
   * Registers (or re-registers) this account's webhook on the gateway and stores the generated
   * secret encrypted.
   *
   * A fresh secret is minted per registration rather than reusing a global one, so revoking a
   * single session never forces a rotation across every other. The old subscription is deleted
   * first — leaving it would double-deliver every event.
   */
  async provisionWebhook(account: ChannelAccount, callbackUrl: string): Promise<{ webhookId: string; secret: string }> {
    const sessionId = this.gatewaySessionId(account);

    if (account.webhookExternalId) {
      await this.client
        .deleteWebhook(sessionId, account.webhookExternalId)
        .catch(() => undefined); // already gone is a fine outcome
    }

    const secret = this.crypto.generateToken(32);
    const webhook = await this.client.createWebhook(sessionId, {
      url: callbackUrl,
      events: [...SUBSCRIBED_EVENTS],
      secret,
      retryCount: 3,
    });

    this.logger.log('Registered gateway webhook', {
      channelAccountId: account.id,
      webhookId: webhook.id,
      events: SUBSCRIBED_EVENTS.length,
    });
    return { webhookId: webhook.id, secret };
  }

  /**
   * Registers the inbound callback if this account has none, and reports what it found.
   *
   * The repair path for a silent half-failure: a session that connects but has no callback sends
   * perfectly and receives nothing. That happens when the gateway could not reach the API at pairing
   * time, or when a connect call timed out while the session was still starting — both leave a
   * working session and no way for a message to come back.
   *
   * Only ever adds. An account that already has a registration is left untouched, so running this on
   * a timer cannot churn secrets or double-deliver events.
   */
  async ensureInboundCallback(
    channelAccountId: string,
    callbackUrl: string,
  ): Promise<{ registered: boolean; repaired: boolean }> {
    const account = await this.loadAccount(channelAccountId);
    if (account.webhookExternalId) return { registered: true, repaired: false };

    // No gateway session yet means nothing to attach a webhook to; not an error, just not yet.
    if (!account.externalId) return { registered: false, repaired: false };

    const { webhookId, secret } = await this.provisionWebhook(account, callbackUrl);
    await this.accounts.update(account.id, {
      webhookExternalId: webhookId,
      webhookSecretEncrypted: this.encryptWebhookSecret(account.id, secret),
    });

    this.logger.warn('Inbound callback was missing and has been registered', {
      channelAccountId,
      webhookId,
    });
    return { registered: true, repaired: true };
  }

  encryptWebhookSecret(accountId: string, secret: string): string {
    return this.crypto.encryptSecret(secret, `channel_account:${accountId}:webhookSecret`);
  }

  /** Null when unprovisioned — which `verifySignature` treats as a rejection, never as a bypass. */
  decryptWebhookSecret(account: { id: string; webhookSecretEncrypted: string | null }): string | null {
    if (!account.webhookSecretEncrypted) return null;
    try {
      return this.crypto.decryptSecret(
        account.webhookSecretEncrypted,
        `channel_account:${account.id}:webhookSecret`,
      );
    } catch (error) {
      // A row that will not decrypt means a rotated master key or a tampered/copied row. Refuse
      // rather than falling back to unsigned acceptance.
      this.logger.error('Stored webhook secret could not be decrypted', {
        channelAccountId: account.id,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /** Reads only `sessionId` from an UNVERIFIED body, to find which account's secret to check. */
  identifyWebhookAccount(rawBody: Buffer): string | null {
    try {
      const parsed = JSON.parse(rawBody.toString('utf8')) as { sessionId?: unknown };
      return typeof parsed?.sessionId === 'string' ? parsed.sessionId.slice(0, 128) : null;
    } catch {
      return null;
    }
  }

  private async loadAccount(channelAccountId: string): Promise<ChannelAccount> {
    const account = await this.accounts.findOne({ where: { id: channelAccountId } });
    if (!account) throw new Error(`Channel account ${channelAccountId} not found`);
    return account;
  }

  /**
   * The gateway session id (a UUID) for an account, or a clear failure.
   *
   * Every `/api/sessions/{sessionId}/…` route validates its parameter as a UUID. Passing the
   * operator-chosen NAME instead produces `400 "Validation failed (uuid is expected)"` — the
   * Phase 2 defect real-gateway validation found. Routing every path construction through this
   * one accessor is what stops it recurring: there is no other way to obtain the value, and it
   * refuses rather than silently substituting the name.
   */
  private gatewaySessionId(account: ChannelAccount): string {
    if (!account.externalId) {
      throw new ConflictException(
        `Channel account "${account.externalName}" has no gateway session yet. Connect it first.`,
      );
    }
    return account.externalId;
  }

  private toAccountState(
    externalId: string,
    rawStatus: string,
    session: { phone?: string | null; pushName?: string | null; lastError?: string | null },
  ): ChannelAccountState {
    const status = mapSessionStatus(rawStatus);
    return {
      externalId,
      status,
      capabilities: whatsAppCapabilities(status === ChannelConnectionState.CONNECTED),
      displayIdentity: session.pushName ?? session.phone ?? null,
      // The account's own number, kept separate from the display name so participant matching has
      // something exact to compare against.
      accountPhone: extractPhone(session.phone),
      lastError: session.lastError ?? null,
    };
  }
}

// --- sanitisers ------------------------------------------------------------------------------
// Everything a channel hands us is untrusted (brief §21): group names, display names, phone
// numbers, message text and external ids alike.

/** Trims, strips control characters, and caps length. Null for anything empty. */
export function sanitizeText(value: string | null | undefined, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  // Strip C0/C1 control characters. They serve no purpose in a display string and are a classic
  // vector for log injection and terminal escape sequences.
  const cleaned = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
}

/**
 * Reduces a declared MIME type to a bare `type/subtype`.
 *
 * Parameters are dropped and the shape is validated, so a hostile value cannot smuggle a header
 * injection or a path through. An unusable value becomes `application/octet-stream` — deliberately
 * the least-privileged interpretation, never the caller's claim.
 */
export function sanitizeMimeType(value: string | null | undefined): string {
  if (typeof value !== 'string') return 'application/octet-stream';
  const base = value.split(';')[0].trim().toLowerCase().slice(0, 128);
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(base) ? base : 'application/octet-stream';
}

/**
 * Reduces a declared filename to a safe basename.
 *
 * Strips every directory component and any leading dots, so `../../etc/passwd` becomes `passwd`.
 * Phase 2 never writes these to disk, but the value is displayed and will later be used for
 * downloads — sanitising at the boundary means no consumer has to remember to.
 */
export function sanitizeFilename(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const base = value.split(/[/\\]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001F\u007F]/g, '').replace(/^\.+/, '').trim();
  return cleaned ? cleaned.slice(0, 255) : null;
}

/** Clamps a declared size to a non-negative, plausible value. Returns null for nonsense. */
export function clampSize(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const oneGigabyte = 1024 * 1024 * 1024;
  return Math.min(Math.floor(value), oneGigabyte);
}

/** Bridges the adapter interface's narrower message-type union to our content type enum. */
function contentTypeToInbound(type: MessageContentType): NormalizedInboundMessage['messageType'] {
  switch (type) {
    case MessageContentType.TEXT:
      return 'text';
    case MessageContentType.IMAGE:
      return 'image';
    case MessageContentType.VIDEO:
      return 'video';
    case MessageContentType.AUDIO:
      return 'audio';
    case MessageContentType.DOCUMENT:
      return 'document';
    case MessageContentType.STICKER:
      return 'sticker';
    case MessageContentType.LOCATION:
      return 'location';
    case MessageContentType.CONTACT:
      return 'contact';
    case MessageContentType.REACTION:
      return 'reaction';
    case MessageContentType.SYSTEM_EVENT:
      return 'system';
    default:
      return 'unsupported';
  }
}
