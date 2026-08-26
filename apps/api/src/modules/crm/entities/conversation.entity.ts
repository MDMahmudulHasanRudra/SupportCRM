import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ChannelKey } from '../../channel/entities/channel.entity';
import {
  ConversationControlState,
  ConversationKind,
  ConversationPriority,
  ConversationStatus,
} from '../conversation-states';
import { ConversationParticipant } from './conversation-participant.entity';

/**
 * The central conversation entity — channel-neutral (Phase 3 brief §3).
 *
 * Nothing here says WhatsApp. `externalConversationId` is whatever the channel calls a chat, and a
 * Messenger adapter would fill the same column with a thread id. That is the property that makes
 * `PROJECT_SPEC.md` §139's future channels an adapter rather than a rewrite.
 *
 * ## Two state axes
 *
 * `status` (lifecycle) and `controlState` (who may respond) are independent — see
 * `conversation-states.ts` for why, and for the projection onto `PROJECT_SPEC.md` §7's single list.
 *
 * ## What this entity does NOT do
 *
 * It stores state. It decides nothing. `aiEnabled`, `automationEnabled`, `controlState` and
 * `pausedUntil` are read by the Phase 5 Message Decision Engine; Phase 3 contains no logic that
 * interprets them (brief §6, §16).
 *
 * ## Customer linkage
 *
 * `customerId` is nullable and stays null until an identity is CONFIRMED. A group conversation may
 * legitimately have no single customer at all — the brief §4 is explicit that one group does not
 * equal one customer — so for groups this is a *primary* customer at most, and
 * `conversation_participants` carries the full picture.
 */
@Entity('conversations')
@Index(['channelAccountId', 'externalConversationId'], { unique: true })
@Index(['status', 'lastMessageAt'])
@Index(['assignedToUserId', 'status'])
@Index(['customerId'])
export class Conversation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 32 })
  channelKey!: ChannelKey;

  @Column({ type: 'uuid' })
  channelAccountId!: string;

  /** The channel's chat identifier. Unique per account — one chat is one conversation. */
  @Column({ type: 'varchar', length: 190 })
  externalConversationId!: string;

  @Column({ type: 'varchar', length: 16 })
  kind!: ConversationKind;

  /** Set for GROUP conversations. Null for DIRECT. */
  @Column({ type: 'uuid', nullable: true })
  groupId!: string | null;

  /**
   * The primary customer, once an identity is CONFIRMED.
   *
   * Null is normal and not a defect: an unmatched direct chat, or a group with several customers in
   * it. Never inferred — only a confirmed identity sets this.
   */
  @Column({ type: 'uuid', nullable: true })
  customerId!: string | null;

  /** Display label. For a group, the group name; for a direct chat, the best-known contact name. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  subject!: string | null;

  // --- lifecycle -----------------------------------------------------------------------------
  @Index()
  @Column({ type: 'varchar', length: 24, default: ConversationStatus.OPEN })
  status!: ConversationStatus;

  @Column({ type: 'varchar', length: 16, default: ConversationPriority.NORMAL })
  priority!: ConversationPriority;

  // --- control (read by Phase 5, never interpreted here) ---------------------------------------
  @Column({ type: 'varchar', length: 24, default: ConversationControlState.AUTOMATION_ACTIVE })
  controlState!: ConversationControlState;

  /**
   * Per-conversation overrides.
   *
   * Default **false** for both. A conversation must not become eligible for AI or automation merely
   * by existing — `PROJECT_SPEC.md` §46 and the group-level flags established in Phase 2 follow the
   * same rule, and defaulting to on would mean the day Phase 5 ships, every conversation ever
   * created becomes live at once.
   */
  @Column({ type: 'boolean', default: false })
  aiEnabled!: boolean;

  @Column({ type: 'boolean', default: false })
  automationEnabled!: boolean;

  /** While in the future, automated responders must stand down. Cleared by a resume. */
  @Column({ type: 'timestamptz', nullable: true })
  pausedUntil!: Date | null;

  // --- human takeover (brief §7) ----------------------------------------------------------------
  @Column({ type: 'uuid', nullable: true })
  takeoverByUserId!: string | null;

  @Column({ type: 'text', nullable: true })
  takeoverReason!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  takeoverAt!: Date | null;

  /**
   * Optional expiry. A takeover with no expiry holds until explicitly released; one with an expiry
   * is swept back to its previous control state, so a human who forgets to release does not leave a
   * conversation silently unattended forever.
   */
  @Column({ type: 'timestamptz', nullable: true })
  takeoverExpiresAt!: Date | null;

  // --- assignment (current pointer; history lives in conversation_assignments) --------------------
  @Column({ type: 'uuid', nullable: true })
  assignedToUserId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  assignedToTeamId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  assignedAt!: Date | null;

  // --- activity ----------------------------------------------------------------------------------
  /** Drives inbox ordering. Denormalised from `messages` so the list needs no aggregate. */
  @Index()
  @Column({ type: 'timestamptz', nullable: true })
  lastMessageAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastInboundAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastOutboundAt!: Date | null;

  @Column({ type: 'int', default: 0 })
  messageCount!: number;

  /** CRM-level pin, independent of any channel's own pin (`PROJECT_SPEC.md` §62). */
  @Column({ type: 'boolean', default: false })
  isPinned!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  resolvedById!: string | null;

  @OneToMany(() => ConversationParticipant, (participant) => participant.conversation)
  participants!: ConversationParticipant[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  /**
   * The automation profile this /usr/bin/bash follows (Phase 5).
   *
   * Null means inherit from a broader scope, or fall back to global settings.
   */
  @Column({ type: 'uuid', nullable: true })
  automationProfileId!: string | null;
}
