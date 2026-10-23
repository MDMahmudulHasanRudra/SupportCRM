import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel, ChannelKey } from './channel.entity';
import type { ChannelCapabilities } from '../channel-capabilities';
import { ChannelConnectionState } from '../channel-connection';

/**
 * One connected account on one channel — for WhatsApp, one gateway session.
 *
 * `PROJECT_SPEC.md` §52–54. Everything channel-specific about the connection is confined to this
 * row and to the adapter; the rest of the system refers to a `channelAccountId` and never learns
 * what a "session" or a "JID" is.
 */
@Entity('channel_accounts')
@Index(['channelKey', 'externalId'], { unique: true })
export class ChannelAccount {
  @Column({type:'varchar',length:32,default:'gowa'})
  gatewayProvider!:string;
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 32 })
  channelKey!: ChannelKey;

  @ManyToOne(() => Channel, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'channelKey', referencedColumnName: 'key' })
  channel!: Channel;

  /**
   * The channel's own identifier for this account.
   *
   * For WhatsApp this is the gateway session's **UUID**, not its name. Every
   * `/api/sessions/{sessionId}/…` route validates the parameter as a UUID, and the webhook
   * envelope's `sessionId` carries the same value — so this one column is what makes inbound
   * lookup and outbound path construction agree.
   *
   * Null until the session has actually been created on the gateway. An account legitimately
   * exists before its session does: registration records the intent, `connect()` learns the id.
   */
  @Column({ type: 'varchar', length: 128, nullable: true })
  externalId!: string | null;

  /**
   * The operator-chosen session name — what `POST /api/sessions {name}` is given, and what an
   * operator recognises the session by. Deliberately NOT the same thing as `externalId`;
   * conflating the two is the Phase 2 defect this column exists to fix.
   */
  @Column({ type: 'varchar', length: 128 })
  externalName!: string;

  @Column({ type: 'varchar', length: 120 })
  label!: string;

  /** Best-effort display identity of the connected account (push name, page name). */
  @Column({ type: 'varchar', length: 120, nullable: true })
  displayIdentity!: string | null;

  /**
   * The channel identity this account is actually paired to — for WhatsApp, its phone number.
   *
   * Distinct from `externalId`, which is the gateway's session NAME and is chosen by the operator.
   * Conflating the two means the connected account cannot recognise its own messages or find itself
   * in a group participant list. Null until the channel reports it, which happens on connect.
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  accountPhone!: string | null;

  @Index()
  @Column({ type: 'varchar', length: 24, default: ChannelConnectionState.DISCONNECTED })
  status!: ChannelConnectionState;

  @Column({ type: 'text', nullable: true })
  lastError!: string | null;

  /**
   * Exactly one account per channel may be primary. Enforced by a partial unique index created in
   * the migration — `WHERE "isPrimary" = true` is not expressible in the TypeORM decorator DSL,
   * the same limitation (and the same hand-written-index workaround) the prior system hit.
   */
  @Column({ type: 'boolean', default: false })
  isPrimary!: boolean;

  /**
   * Snapshot of what this account can actually do, refreshed by the adapter on connect.
   * Null means "never connected, capabilities unknown" — which the UI must treat as "unavailable",
   * not as "supported" (`PROJECT_SPEC.md` §174: never fake success).
   */
  @Column({ type: 'jsonb', nullable: true })
  capabilities!: ChannelCapabilities | null;

  /**
   * Ownership switch (Phase 2 brief §3). False means Support CRM keeps the account row and its
   * history but stops driving it: no connect, no send, no sync, and inbound events are recorded as
   * received-but-not-owned rather than processed. Deliberately separate from `status`, which
   * describes what the gateway is doing, not what we intend.
   */
  @Column({ type: 'boolean', default: true })
  ownershipEnabled!: boolean;

  /**
   * The webhook subscription this account registered on the gateway, so a re-registration can
   * update rather than duplicate it. Null until the webhook has been provisioned.
   */
  @Column({ type: 'varchar', length: 128, nullable: true })
  webhookExternalId!: string | null;

  /**
   * Per-account HMAC secret the gateway signs this account's webhook bodies with, stored as an
   * AES-256-GCM envelope bound to this row's id. Never returned by any API, never logged.
   * Per-account rather than global so revoking one session cannot require rotating every other.
   */
  @Column({ type: 'text', nullable: true })
  webhookSecretEncrypted!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastConnectedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastHeartbeatAt!: Date | null;

  // --- automatic recovery (Phase 3.5) -----------------------------------------------------------

  /** Consecutive failed automatic reconnects. Zeroed the moment the account connects. */
  @Column({ type: 'int', default: 0 })
  recoveryAttempts!: number;

  /** When the next automatic attempt is due. Null when none is scheduled. */
  @Column({ type: 'timestamptz', nullable: true })
  recoveryNextAttemptAt!: Date | null;

  /** Set when the attempt budget is spent — the account is waiting for a human. */
  @Column({ type: 'timestamptz', nullable: true })
  recoveryExhaustedAt!: Date | null;

  /**
   * Set when an operator asked for this account to be down.
   *
   * Automatic recovery skips these entirely. Reconnecting an account somebody deliberately
   * disconnected would be the single most annoying thing this feature could do.
   */
  @Column({ type: 'timestamptz', nullable: true })
  disconnectRequestedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
