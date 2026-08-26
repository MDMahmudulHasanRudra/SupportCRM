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
import { Conversation } from './conversation.entity';

/**
 * What a participant is to us in this conversation.
 *
 * Mirrors Phase 2's `ParticipantType` deliberately — the same caution applies. `UNKNOWN` is the
 * honest default; `CUSTOMER` is only ever written from a CONFIRMED `customer_identities` row.
 */
export enum ConversationParticipantType {
  CUSTOMER = 'CUSTOMER',
  TEAM_MEMBER = 'TEAM_MEMBER',
  /** The connected channel account itself. */
  ACCOUNT = 'ACCOUNT',
  /** A channel-generated participant, e.g. a system notification author. */
  SYSTEM = 'SYSTEM',
  UNKNOWN = 'UNKNOWN',
}

/**
 * One participant in one conversation (Phase 3 brief §4).
 *
 * This table is why "one group equals one customer" is not baked in anywhere. A group can hold
 * several customers, several team members, the account itself, and people nobody has identified —
 * and each gets a row with its own type, rather than the conversation carrying a single
 * `customerId` that would have to lie.
 *
 * For a DIRECT conversation there are normally two rows (the contact and the account), which keeps
 * the shape uniform: nothing downstream needs a special case for direct chats.
 *
 * Participants are **deactivated, never deleted** when they leave. A message from six months ago
 * must still resolve to who its sender was at the time, and deleting the row would orphan that.
 */
@Entity('conversation_participants')
@Index(['conversationId', 'externalId'], { unique: true })
@Index(['conversationId', 'isActive'])
@Index(['customerId'])
export class ConversationParticipant {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  conversationId!: string;

  @ManyToOne(() => Conversation, (conversation) => conversation.participants, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversationId' })
  conversation!: Conversation;

  /** The channel's participant identifier. */
  @Column({ type: 'varchar', length: 190 })
  externalId!: string;

  /** The resolved channel identity, when we have one. */
  @Column({ type: 'uuid', nullable: true })
  customerIdentityId!: string | null;

  /** Set only when the identity is CONFIRMED. Null otherwise — never inferred. */
  @Column({ type: 'uuid', nullable: true })
  customerId!: string | null;

  /** Set when the participant matches a `team_member_identities` row. */
  @Column({ type: 'uuid', nullable: true })
  teamMemberIdentityId!: string | null;

  @Column({ type: 'varchar', length: 16, default: ConversationParticipantType.UNKNOWN })
  participantType!: ConversationParticipantType;

  /** Untrusted channel-supplied name, kept for display when no identity is resolved. */
  @Column({ type: 'varchar', length: 190, nullable: true })
  displayName!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  phone!: string | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  firstSeenAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastSeenAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
