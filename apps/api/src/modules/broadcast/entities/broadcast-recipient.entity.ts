import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * The statuses a recipient can actually be in (`PROJECT_SPEC.md` §195).
 *
 * No status here is invented. `DELIVERED` appears only when the channel reports a delivery receipt;
 * a broadcast that was handed to WhatsApp and acknowledged is `SENT`, and calling that "delivered"
 * would be telling an operator something nobody verified.
 */
export enum BroadcastRecipientStatus {
  PENDING = 'PENDING',
  QUEUED = 'QUEUED',
  SENT = 'SENT',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
  /** Excluded before sending — opted out, no address, or the account cannot reach them. */
  SKIPPED = 'SKIPPED',
  CANCELLED = 'CANCELLED',
}

/**
 * One intended recipient of one broadcast (§94–§97, §196).
 *
 * Materialised when the broadcast starts, not recomputed per batch. Two reasons, both learned the
 * hard way by everyone who has built one of these:
 *
 *  1. **The audience must not drift mid-send.** A group that gains a member after the operator
 *     approved the audience would otherwise receive a message nobody approved for them.
 *  2. **Retries must be safe.** `UNIQUE (broadcastId, externalConversationId)` means a retried
 *     batch cannot produce a second row, and a row already `SENT` is not sent again.
 */
@Entity('broadcast_recipients')
@Index(['broadcastId', 'status'])
export class BroadcastRecipient {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  broadcastId!: string;

  @Column({ type: 'uuid', nullable: true })
  groupId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  conversationId!: string | null;

  /** The address actually written to. Resolved once, at start. */
  @Column({ type: 'varchar', length: 190 })
  externalConversationId!: string;

  @Column({ type: 'varchar', length: 190, nullable: true })
  displayName!: string | null;

  @Column({ type: 'varchar', length: 16, default: BroadcastRecipientStatus.PENDING })
  status!: BroadcastRecipientStatus;

  @Column({ type: 'uuid', nullable: true })
  outboundMessageId!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  failureReason!: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  skippedReason!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
