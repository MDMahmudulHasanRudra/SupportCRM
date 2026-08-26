import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum ProviderEventStatus {
  /** Accepted, persisted, queued. Nothing has processed it yet. */
  RECEIVED = 'RECEIVED',
  PROCESSED = 'PROCESSED',
  /** Consciously not processed — an event type we do not consume, or an unowned account. */
  IGNORED = 'IGNORED',
  FAILED = 'FAILED',
}

/**
 * The idempotency ledger for everything a gateway delivers (Phase 2 brief §4, §19).
 *
 * The gateway's own documentation warns that a queue failure can cause both a queued job and a
 * direct fallback to POST the same event — both carrying the same `X-OpenWA-Idempotency-Key`. It
 * states plainly that the receiver must dedupe. This table is how we do.
 *
 * The guarantee is a database UNIQUE constraint on (channelAccountId, providerIdempotencyKey), not
 * an application check: two API replicas can race the check, but they cannot both win the insert.
 * The Redis dedupe helper is only a fast path in front of it.
 *
 * Scoped by `channelAccountId` because a provider's key is unique per account, not globally.
 *
 * `rawPayload` is retained for a bounded window only (`PROJECT_SPEC.md` §127, and the brief's
 * "do not unnecessarily store sensitive raw payloads forever"): it holds customer message content,
 * so `purgeExpiredPayloads()` nulls it once `payloadRetainedUntil` passes while the row itself —
 * the part that provides idempotency — is kept.
 */
@Entity('provider_events')
@Index(['channelAccountId', 'providerIdempotencyKey'], { unique: true })
@Index(['status', 'createdAt'])
export class ProviderEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  channelAccountId!: string;

  /** `X-OpenWA-Idempotency-Key` — the provider's own dedupe token. */
  @Column({ type: 'varchar', length: 190 })
  providerIdempotencyKey!: string;

  /** `X-OpenWA-Delivery-Id` — distinct per delivery attempt; useful for correlating gateway logs. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  providerDeliveryId!: string | null;

  /** The provider's event name, e.g. `message.received`. Stored raw for diagnosis. */
  @Index()
  @Column({ type: 'varchar', length: 64 })
  eventType!: string;

  @Column({ type: 'varchar', length: 16, default: ProviderEventStatus.RECEIVED })
  status!: ProviderEventStatus;

  /** Bounded-retention copy of the verified body. Nulled by the retention sweep. */
  @Column({ type: 'jsonb', nullable: true })
  rawPayload!: Record<string, unknown> | null;

  @Column({ type: 'timestamptz', nullable: true })
  payloadRetainedUntil!: Date | null;

  /** Set once processing produces a domain row, so an event can be traced to its message. */
  @Column({ type: 'uuid', nullable: true })
  messageId!: string | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  /** How many times the gateway had already retried when this arrived (`X-OpenWA-Retry-Count`). */
  @Column({ type: 'int', default: 0 })
  providerRetryCount!: number;

  @Column({ type: 'timestamptz', nullable: true })
  processedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
