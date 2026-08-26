import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export enum EscalationStatus {
  OPEN = 'OPEN',
  ASSIGNED = 'ASSIGNED',
  RESOLVED = 'RESOLVED',
  DISMISSED = 'DISMISSED',
}

/** Why a conversation needs a person. Kept as tokens so they can be counted and filtered. */
export enum EscalationReason {
  LOW_CONFIDENCE = 'LOW_CONFIDENCE',
  AI_UNAVAILABLE = 'AI_UNAVAILABLE',
  AI_FAILED = 'AI_FAILED',
  KNOWLEDGE_INSUFFICIENT = 'KNOWLEDGE_INSUFFICIENT',
  CUSTOMER_REQUESTED = 'CUSTOMER_REQUESTED',
  RULE_ESCALATION = 'RULE_ESCALATION',
  REPEATED_FAILURE = 'REPEATED_FAILURE',
  NO_AUTOMATION_MATCH = 'NO_AUTOMATION_MATCH',
}

/**
 * A conversation waiting for a human.
 *
 * A partial unique index keeps at most one OPEN or ASSIGNED escalation per conversation: a
 * conversation that escalates on three consecutive messages is one problem, not three items in
 * somebody's queue.
 */
@Entity('escalations')
@Index(['status', 'createdAt'])
export class Escalation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  conversationId!: string;

  @Column({ type: 'uuid', nullable: true })
  messageId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  decisionId!: string | null;

  @Column({ type: 'varchar', length: 48 })
  reason!: EscalationReason;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  detail!: string | null;

  @Column({ type: 'numeric', precision: 4, scale: 3, nullable: true })
  confidence!: string | null;

  @Column({ type: 'varchar', length: 16, default: EscalationStatus.OPEN })
  status!: EscalationStatus;

  @Column({ type: 'uuid', nullable: true })
  assignedToUserId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  assignedToTeamId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  resolvedById!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  /** How urgently this needs a person, from the escalation score (§40). */
  @Column({ type: 'varchar', length: 16, default: 'NORMAL' })
  priority!: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

  /** The score that produced the priority, so "why was this urgent?" stays answerable. */
  @Column({ type: 'int', nullable: true })
  score!: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  notifiedAt!: Date | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  resolutionNote!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
