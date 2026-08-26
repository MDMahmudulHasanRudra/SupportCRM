/**
 * Channel-neutral webhook verification types.
 *
 * These live here, not inside `whatsapp/`, because the ingestion layer must be able to verify a
 * delivery from ANY channel without importing that channel's implementation. Keeping them in the
 * adapter's directory was the last real coupling in Phase 2 — the ESLint boundary rule caught it,
 * which is the whole reason that rule exists.
 */

/** Why a delivery was refused. Deliberately coarse: the detail belongs in the security log. */
export enum WebhookRejectionReason {
  MISSING_SECRET = 'MISSING_SECRET',
  MISSING_SIGNATURE = 'MISSING_SIGNATURE',
  MALFORMED_SIGNATURE = 'MALFORMED_SIGNATURE',
  MISMATCH = 'MISMATCH',
  REPLAY_WINDOW = 'REPLAY_WINDOW',
  MALFORMED_BODY = 'MALFORMED_BODY',
  UNKNOWN_ACCOUNT = 'UNKNOWN_ACCOUNT',
}

export class WebhookVerificationError extends Error {
  constructor(readonly reason: WebhookRejectionReason) {
    super(`Webhook rejected: ${reason}`);
    this.name = 'WebhookVerificationError';
  }
}

/** A verified delivery, decomposed into what ingestion needs and nothing more. */
export interface VerifiedWebhook {
  /** The provider's event name, kept raw for the audit trail. */
  eventType: string;
  /** The provider's dedupe token — the value the unique index is built on. */
  providerIdempotencyKey: string;
  providerDeliveryId: string | null;
  providerRetryCount: number;
  /** The verified body, stored under the retention policy. */
  payload: Record<string, unknown>;
  /** False for events this channel delivers but Support CRM does not consume. */
  consumed: boolean;
}

/** The minimum an adapter needs to verify a delivery. Avoids passing a whole ORM entity across the seam. */
export interface WebhookAccountRef {
  id: string;
  /** The channel's own id for this account. Null before a session exists. */
  externalId: string | null;
  webhookSecretEncrypted: string | null;
}
