import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { DecisionOutcome, DecisionStatus } from '../decision-types';

/**
 * Why the system did what it did, for one inbound message (`PROJECT_SPEC.md` §157; brief §12).
 *
 * Distinct from `audit_logs`: audit explains **administrative changes**, this explains **runtime
 * decisions**. Conflating them would make both harder to read.
 *
 * `messageId` is uniquely indexed. That single constraint is what makes "one message, at most one
 * authoritative decision" a property of the database rather than a hope about application code — a
 * duplicate webhook, a redelivered job and a second worker all collide on it.
 *
 * What is deliberately NOT stored: the customer's message body, the generated answer, any prompt,
 * any credential. The decision log is read by more people than the inbox is, and it exists to
 * explain a decision, not to duplicate the conversation.
 */
@Entity('decision_logs')
@Index(['conversationId', 'createdAt'])
@Index(['outcome', 'createdAt'])
export class DecisionLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  messageId!: string;

  @Column({ type: 'uuid', nullable: true })
  conversationId!: string | null;

  @Column({ type: 'uuid' })
  channelAccountId!: string;

  @Column({ type: 'uuid', nullable: true })
  groupId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  customerId!: string | null;

  @Column({ type: 'varchar', length: 16, default: DecisionStatus.IN_PROGRESS })
  status!: DecisionStatus;

  @Column({ type: 'varchar', length: 24, nullable: true })
  outcome!: DecisionOutcome | null;

  @Column({ type: 'varchar', length: 48, nullable: true })
  reasonCode!: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  reason!: string | null;

  @Column({ type: 'uuid', nullable: true })
  ruleId!: string | null;

  @Column({ type: 'int', nullable: true })
  ruleVersion!: number | null;

  @Column({ type: 'uuid', nullable: true })
  profileId!: string | null;

  /** Rules that matched but lost, so "why THAT rule?" is answerable. */
  @Column({ type: 'jsonb', nullable: true })
  candidateRuleIds!: string[] | null;

  @Column({ type: 'varchar', length: 48, nullable: true })
  aiProvider!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  aiModel!: string | null;

  @Column({ type: 'numeric', precision: 4, scale: 3, nullable: true })
  confidence!: string | null;

  /**
   * Whether `confidence` is a measured probability.
   *
   * It is not. A language model's self-report reads like a probability and is not calibrated
   * against anything. Recorded explicitly so that nobody downstream — a report, a dashboard, a
   * future phase — mistakes the number for something it is not.
   */
  @Column({ type: 'boolean', default: false })
  confidenceCalibrated!: boolean;

  @Column({ type: 'boolean', default: false })
  knowledgeUsed!: boolean;

  @Column({ type: 'jsonb', nullable: true })
  knowledgeArticleIds!: string[] | null;

  @Column({ type: 'jsonb', nullable: true })
  knowledgeChunkIds!: string[] | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  escalationReason!: string | null;

  @Column({ type: 'boolean', default: false })
  humanRequired!: boolean;

  @Column({ type: 'uuid', nullable: true })
  responseMessageId!: string | null;

  @Column({ type: 'int', nullable: true })
  processingTimeMs!: number | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  error!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
