/**
 * The OpenWA gateway's wire contracts, transcribed from the vendored source at `gateway/`.
 *
 * Every type here was read from real code, not inferred — `docs/adr/0001` §2 records where each
 * came from. Nothing in this file may be guessed: the Phase 2 brief §1 is explicit that inventing
 * endpoints, event names or payload shapes is not acceptable, and a wrong assumption here surfaces
 * as silent data loss rather than a compile error.
 *
 * Source references (gateway/, v0.23.1):
 *   IncomingMessage        src/engine/interfaces/whatsapp-engine.interface.ts:86
 *   DeliveryStatus         src/engine/interfaces/whatsapp-engine.interface.ts:513
 *   WebhookPayload         src/modules/webhook/webhook-delivery.service.ts:25
 *   webhook headers        src/modules/webhook/webhook-delivery.service.ts:385-390, 453-457
 *   session status enum    openapi.json  GET /api/sessions/{sessionId}
 *   subscribable events    src/modules/events/dto/ws-messages.dto.ts
 *
 * This file is importable ONLY from `modules/channel/whatsapp` — enforced by the ESLint boundary.
 */

/** Gateway session lifecycle. Mapped to `ChannelConnectionState`; never used outside the adapter. */
export type OpenWaSessionStatus =
  | 'created'
  | 'initializing'
  | 'qr_ready'
  | 'authenticating'
  | 'ready'
  | 'disconnected'
  | 'action_required'
  | 'failed';

/** `GET|POST /api/sessions[/{id}][/start|/stop|/logout]`. */
export interface OpenWaSession {
  id: string;
  name: string;
  status: OpenWaSessionStatus;
  phone?: string | null;
  pushName?: string | null;
  connectedAt?: string | null;
  lastActive?: string | null;
  createdAt?: string;
  updatedAt?: string;
  lastError?: string | null;
  restriction?: Record<string, unknown> | null;
  engineLoaded?: boolean;
}

/** `GET /api/sessions/{id}/qr`. `qrCode` is a secret-equivalent — never logged, never audited. */
export interface OpenWaQrResponse {
  qrCode?: string | null;
  status: OpenWaSessionStatus;
}

/** `GET /api/sessions/{id}/groups?limit&offset` — the cheap listing; no participants. */
export interface OpenWaGroupSummary {
  id: string;
  name: string;
  linkedParentJID?: string;
}

/** `GET /api/sessions/{id}/groups/{groupId}` — the detail call that carries participants. */
export interface OpenWaGroupDetail extends OpenWaGroupSummary {
  description?: string;
  owner?: string;
  createdAt?: number;
  participants: OpenWaGroupParticipant[];
  isReadOnly?: boolean;
  isAnnounce?: boolean;
  announce?: boolean;
  locked?: boolean;
  ephemeralSeconds?: number;
  memberAddMode?: 'all' | 'admins';
}

export interface OpenWaGroupParticipant {
  id: string;
  number: string;
  name?: string;
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

/** Response of every `messages/send-*` and `messages/reply` endpoint. */
export interface OpenWaSendResult {
  messageId: string;
  /** Epoch seconds. */
  timestamp: number;
}

/** `POST|GET /api/sessions/{id}/webhooks`. */
export interface OpenWaWebhook {
  id: string;
  sessionId: string;
  url: string;
  events: string[];
  active: boolean;
  retryCount: number;
  filters?: Record<string, unknown>;
  lastTriggeredAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * `GET /api/sessions/{id}/automation-rules`.
 *
 * Support CRM never creates one of these. This type exists solely so the diagnostic in
 * `WhatsAppAutomationGuard` can READ them and refuse to operate a session the gateway is also
 * autoreplying on — see `docs/adr/0001` §6.
 */
export interface OpenWaAutomationRule {
  id: string;
  sessionId: string;
  name: string;
  enabled: boolean;
  replyText: string;
  cooldownSeconds: number;
  conditions?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Neutral delivery signal the gateway emits on `message.ack`. */
export type OpenWaDeliveryStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

/** The message shape delivered on `message.received` / `message.sent`. */
export interface OpenWaIncomingMessage {
  id: string;
  from: string;
  to: string;
  chatId: string;
  body: string;
  type: string;
  /** Epoch seconds. */
  timestamp: number;
  fromMe: boolean;
  isGroup: boolean;
  kind?: string;
  isStatusBroadcast?: boolean;
  ephemeralDuration?: number;
  /** In a group, the participant who actually sent it — `from` is the group JID there. */
  author?: string;
  mentionedIds?: string[];
  call?: { video: boolean; missed: boolean };
  isLidSender?: boolean;
  senderPhone?: string | null;
  contact?: { pushname?: string; name?: string; shortName?: string; number?: string };
  media?: {
    mimetype: string;
    filename?: string;
    data?: string;
    omitted?: boolean;
    sizeBytes?: number;
  };
  quotedMessage?: { id: string; body: string };
  location?: {
    latitude: number;
    longitude: number;
    description?: string;
    address?: string;
    url?: string;
  };
}

/** `message.ack` payload. `ack` is the gateway's deprecated legacy integer; read `status`. */
export interface OpenWaAckPayload {
  id: string;
  messageId: string;
  status: OpenWaDeliveryStatus;
  ack?: number;
}

/** The envelope wrapping every webhook body. */
export interface OpenWaWebhookEnvelope {
  event: string;
  timestamp: string;
  sessionId: string;
  idempotencyKey: string;
  deliveryId: string;
  data: Record<string, unknown>;
}

/** Header names the gateway sets on every delivery. */
export const OPENWA_HEADERS = {
  SIGNATURE: 'x-openwa-signature',
  EVENT: 'x-openwa-event',
  IDEMPOTENCY_KEY: 'x-openwa-idempotency-key',
  DELIVERY_ID: 'x-openwa-delivery-id',
  RETRY_COUNT: 'x-openwa-retry-count',
} as const;

/**
 * Webhook events Support CRM subscribes to.
 *
 * A deliberately narrow subset of the 21 the gateway offers. Subscribing to `*` would mean
 * accepting presence updates and call events we have nowhere to put, at real volume, for no
 * benefit — and every accepted event costs a `provider_events` row.
 */
export const SUBSCRIBED_EVENTS = [
  'message.received',
  'message.sent',
  'message.ack',
  'message.revoked',
  'session.status',
  'session.qr',
  'session.authenticated',
  'session.disconnected',
  'group.join',
  'group.leave',
  'group.update',
] as const;

export type SubscribedEvent = (typeof SUBSCRIBED_EVENTS)[number];

export function isSubscribedEvent(event: string): event is SubscribedEvent {
  return (SUBSCRIBED_EVENTS as readonly string[]).includes(event);
}
