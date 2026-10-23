import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ChannelKey } from '../../channel/entities/channel.entity';
import {
  DeliveryStatus,
  MessageClassification,
  MessageContentType,
  MessageDirection,
  MessageProcessingStatus,
} from '../message-types';
import { MessageAttachment } from './message-attachment.entity';

/**
 * The normalized message log — one row per real message, inbound or outbound, on any channel.
 *
 * `PROJECT_SPEC.md` §66 and Phase 2 brief §5. Two rules give this table its value:
 *
 *  1. **No provider vocabulary.** There is no `waMessageId`, no `chatId`, no JID. Adapters translate
 *     at the boundary. A Messenger adapter fills the same columns with different values and nothing
 *     downstream changes.
 *  2. **Idempotency is a database constraint.** `UNIQUE (channelAccountId, externalId)` is what makes
 *     duplicate webhook delivery harmless. An application-level check cannot survive two replicas
 *     racing; a unique index can.
 *
 * `conversationId` is deliberately a plain nullable column with no foreign key: conversations arrive
 * in Phase 3, and a message must be persistable now without one. Phase 3 backfills and adds the FK.
 */
@Entity('messages')
@Index(['channelAccountId', 'externalId'], { unique: true })
@Index(['externalConversationId', 'sentAt'])
@Index(['conversationId', 'sentAt'])
@Index(['channelAccountId', 'sentAt'])
export class Message {
  @Column({type:'jsonb',default:()=>"'{}'::jsonb"})
  presentation!: Record<string,unknown>;

  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 32 })
  channelKey!: ChannelKey;

  @Column({ type: 'uuid' })
  channelAccountId!: string;

  /** The provider's message id. Half of the idempotency key. */
  @Column({ type: 'varchar', length: 255 })
  externalId!: string;

  /** The provider's chat/conversation identifier. */
  @Column({ type: 'varchar', length: 190 })
  externalConversationId!: string;

  /** Set when the conversation is a group; null for a direct chat. */
  @Index()
  @Column({ type: 'varchar', length: 190, nullable: true })
  externalGroupId!: string | null;

  /** Resolved `groups.id` when the group is known to us. Null if it has not been synced yet. */
  @Column({ type: 'uuid', nullable: true })
  groupId!: string | null;

  /**
   * The conversation this message belongs to.
   *
   * Phase 2 shipped this as a plain nullable column so messages could be persisted before
   * conversations existed; Phase 3's migration added the foreign key (ON DELETE SET NULL — deleting
   * a conversation must never destroy the message record).
   */
  @Column({ type: 'uuid', nullable: true })
  conversationId!: string | null;

  /**
   * The sender's resolved channel identity (Phase 3 brief §5).
   *
   * An identity, not a customer: it records *which channel address* sent this, which is knowable
   * from the message alone. Whether that address belongs to a customer is a separate, human-confirmed
   * fact on `customer_identities.matchState`.
   */
  @Column({ type: 'uuid', nullable: true })
  senderIdentityId!: string | null;

  @Column({ type: 'varchar', length: 16 })
  direction!: MessageDirection;

  /**
   * Stable sender identity. In a group this is the participant who actually spoke — never the group
   * itself, which is what the provider puts in its `from` field and a classic source of bugs.
   */
  @Column({ type: 'varchar', length: 190 })
  senderExternalId!: string;

  /** Digits only, where the channel exposes a phone number at all. Untrusted input; length-capped. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  senderPhone!: string | null;

  /** Provider-supplied display name. Fully untrusted — never rendered without escaping. */
  @Column({ type: 'varchar', length: 190, nullable: true })
  senderDisplayName!: string | null;

  @Column({ type: 'varchar', length: 24 })
  contentType!: MessageContentType;

  /**
   * Body text, or the caption of a media message. Capped at persist time: an oversized body is a
   * cheap denial-of-service against the database and every consumer downstream.
   */
  @Column({ type: 'text', nullable: true })
  body!: string | null;

  /** The provider's id of the quoted message, when this is a reply. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  quotedExternalId!: string | null;

  /** Resolved local message, when we have the quoted message tracked. */
  @Column({ type: 'uuid', nullable: true })
  quotedMessageId!: string | null;

  /** Provider ids `@`-mentioned in the message. */
  @Column({ type: 'jsonb', nullable: true })
  mentionedExternalIds!: string[] | null;

  @Index()
  @Column({ type: 'varchar', length: 24, default: MessageClassification.UNKNOWN })
  classification!: MessageClassification;

  /** True when the connected account sent it. Never automated on — the primary loop guard. */
  @Column({ type: 'boolean', default: false })
  fromAccount!: boolean;

  /** The provider's timestamp, not our receipt time. Ordering must follow the sender's clock. */
  @Column({ type: 'timestamptz' })
  sentAt!: Date;

  @Column({ type: 'varchar', length: 16, default: MessageProcessingStatus.PENDING })
  processingStatus!: MessageProcessingStatus;

  /** Set for OUTBOUND rows so the inbox can show a delivery tick. Null for INBOUND. */
  @Column({ type: 'varchar', length: 16, nullable: true })
  deliveryStatus!: DeliveryStatus | null;

  /** Links an outbound message back to the send request that produced it. */
  @Column({ type: 'uuid', nullable: true })
  outboundMessageId!: string | null;

  /**
   * A pointer to `provider_events`, not a copy of the payload.
   *
   * The raw provider body contains customer content and is subject to retention (§4 of the brief).
   * Keeping only a reference means the decision inspector can still explain a message today, while
   * the retention sweep can clear the sensitive copy on schedule without touching this table.
   */
  @Column({ type: 'uuid', nullable: true })
  providerEventId!: string | null;

  @OneToMany(() => MessageAttachment, (attachment) => attachment.message)
  attachments!: MessageAttachment[];

  @ManyToOne(() => Message, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'quotedMessageId' })
  quotedMessage!: Message | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
