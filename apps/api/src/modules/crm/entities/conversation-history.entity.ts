import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import {
  ConversationControlState,
  ConversationStatus,
  StateChangeSource,
} from '../conversation-states';

/**
 * Append-only record of every conversation state change (Phase 3 brief §10, §13).
 *
 * `conversations` says what is true now; this says how it got there and who decided. That is the
 * question that matters when a customer asks why nobody answered for two hours, and the reason
 * `PROJECT_SPEC.md` §111 lists `conversation_state_history` as a first-class table rather than
 * something to reconstruct from logs.
 *
 * One row covers both axes because they frequently change together — a takeover sets
 * `HUMAN_ACTIVE` *and* moves the status — and splitting them would make a single operator action
 * read as two unrelated events.
 *
 * No update or delete path exists anywhere in the application.
 */
@Entity('conversation_state_history')
@Index(['conversationId', 'createdAt'])
export class ConversationStateHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  conversationId!: string;

  /** Null when the axis did not change in this transition. */
  @Column({ type: 'varchar', length: 24, nullable: true })
  previousStatus!: ConversationStatus | null;

  @Column({ type: 'varchar', length: 24, nullable: true })
  status!: ConversationStatus | null;

  @Column({ type: 'varchar', length: 24, nullable: true })
  previousControlState!: ConversationControlState | null;

  @Column({ type: 'varchar', length: 24, nullable: true })
  controlState!: ConversationControlState | null;

  @Column({ type: 'varchar', length: 16 })
  source!: StateChangeSource;

  /** Null for a system-driven change such as a takeover expiring. */
  @Column({ type: 'uuid', nullable: true })
  actorId!: string | null;

  /** Denormalised so the entry stays readable if the user is later renamed or removed. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  actorUsername!: string | null;

  /** Operator-supplied, or a system explanation. Surfaced verbatim in the conversation timeline. */
  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

/**
 * Append-only assignment history (Phase 3 brief §8).
 *
 * The brief requires that historical assignment records are never overwritten, so assignment is
 * modelled as a sequence of rows with `unassignedAt` closing each one, rather than as a mutable
 * column. `conversations.assignedToUserId` is a denormalised pointer to the open row — convenient
 * for the inbox query, never the source of truth.
 *
 * "Who had this conversation last Tuesday" is answerable from this table and from nowhere else,
 * and Phase 9's team-performance reporting depends on it.
 */
@Entity('conversation_assignments')
@Index(['conversationId', 'createdAt'])
@Index(['assignedToUserId', 'unassignedAt'])
export class ConversationAssignment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  conversationId!: string;

  /** Exactly one of these two is set. Enforced by a check constraint in the migration. */
  @Column({ type: 'uuid', nullable: true })
  assignedToUserId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  assignedToTeamId!: string | null;

  /** Null for a system assignment such as round-robin (not implemented in Phase 3). */
  @Column({ type: 'uuid', nullable: true })
  assignedById!: string | null;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  /** Null while this is the live assignment. Set when superseded or cleared. */
  @Column({ type: 'timestamptz', nullable: true })
  unassignedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  unassignedById!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
