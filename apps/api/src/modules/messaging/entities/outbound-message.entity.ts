import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ChannelKey } from '../../channel/entities/channel.entity';
import { DeliveryStatus, MessageContentType } from '../message-types';

/**
 * Where a send is decided (`PROJECT_SPEC.md` §56, Phase 2 brief §10, §12).
 *
 * Every outgoing message from every source — a human in the inbox, and later automation, AI and
 * broadcast — becomes a row here first. Nothing calls the adapter directly. That single choke point
 * is what will later let one place enforce rate limits, conversation state, human takeover,
 * emergency stop, duplicate suppression and audit, instead of each caller remembering to.
 *
 * The row is the durable record; Redis moves the work. Flushing Redis loses scheduling, never the
 * request or its outcome (`PROJECT_SPEC.md` §184).
 *
 * `source` is already modelled (§166) even though Phase 2 only ever writes `MANUAL` and `SYSTEM` —
 * every message needs a provenance label from the first one, or the reporting in Phase 9 has a hole
 * exactly the size of the messages sent before the column existed.
 */
export enum OutboundSource {
  MANUAL = 'MANUAL',
  AUTOMATION = 'AUTOMATION',
  AI = 'AI',
  BROADCAST = 'BROADCAST',
  SYSTEM = 'SYSTEM',
}

@Entity('outbound_messages')
@Index(['status', 'scheduledAt'])
@Index(['channelAccountId', 'createdAt'])
export class OutboundMessage {
  @Column({type:'jsonb',nullable:true})
  channelCommand!:import('../../channel/channel-adapter.interface').ChannelCommand|null;
  @Column({type:'timestamptz',nullable:true})
  scheduledFor!:Date|null;
  @Column({type:'uuid',nullable:true})
  managedScheduleId!: string|null;

  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 32 })
  channelKey!: ChannelKey;

  @Column({ type: 'uuid' })
  channelAccountId!: string;

  /** The provider's chat identifier to send to. */
  @Column({ type: 'varchar', length: 190 })
  externalConversationId!: string;

  /** Reserved for Phase 3, like `Message.conversationId`. */
  @Column({ type: 'uuid', nullable: true })
  conversationId!: string | null;

  @Column({ type: 'varchar', length: 24, default: MessageContentType.TEXT })
  contentType!: MessageContentType;

  @Column({ type: 'text', nullable: true })
  body!: string | null;

  /** Send as a reply to this provider message id. Gated on the account's `canReply` capability. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  quotedExternalId!: string | null;

  /** Media descriptors: `{ mimeType, filename, url | base64Ref, caption }`. */
  @Column({ type: 'jsonb', nullable: true })
  attachments!: Record<string, unknown>[] | null;

  /**
   * Caller-supplied, globally unique. A retried HTTP request or a re-delivered job with the same
   * key returns the existing row instead of sending twice — the difference between an at-least-once
   * queue and a customer receiving the same message twice (`PROJECT_SPEC.md` §117, §192).
   * Unique index is partial (`WHERE "idempotencyKey" IS NOT NULL`); see the migration.
   */
  @Column({ type: 'varchar', length: 190, nullable: true })
  idempotencyKey!: string | null;

  @Index()
  @Column({ type: 'varchar', length: 16, default: DeliveryStatus.QUEUED })
  status!: DeliveryStatus;

  @Column({ type: 'varchar', length: 24, default: OutboundSource.MANUAL })
  source!: OutboundSource;

  /** Set once the provider accepts it — this is what links delivery receipts back to this row. */
  @Index()
  @Column({ type: 'varchar', length: 255, nullable: true })
  externalMessageId!: string | null;

  /** The `messages` row created for the accepted send. */
  @Column({ type: 'uuid', nullable: true })
  messageId!: string | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  /** Also the retry-backoff clock: a failed attempt pushes this forward rather than blocking. */
  @Column({ type: 'timestamptz', default: () => 'now()' })
  scheduledAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  lastAttemptAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt!: Date | null;

  /** User-facing reason. `PROJECT_SPEC.md` §122: never fail silently. */
  @Column({ type: 'text', nullable: true })
  failureReason!: string | null;

  /** Null for a system-originated send. */
  @Column({ type: 'uuid', nullable: true })
  createdById!: string | null;

  /** Which decision caused this send. Null for a human pressing send (Phase 5). */
  @Column({ type: 'uuid', nullable: true })
  decisionId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  broadcastId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
