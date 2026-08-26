import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { AIJobSlot, AIMessageRole } from '../ai-types';

/**
 * One AI turn, auditable (`PROJECT_SPEC.md` §27, §114, §165).
 *
 * What is recorded: the role, the text that was actually exchanged, which provider and model,
 * tokens, latency, and the structured verdict — decision, confidence, whether the knowledge was
 * judged sufficient, whether a human was asked for, and which passages were cited.
 *
 * What is deliberately absent: **the model's reasoning**. §27 and §165 forbid exposing or storing
 * chain-of-thought, and a column for it would be filled the moment one existed.
 */
@Entity('ai_messages')
@Index(['conversationId'])
@Index(['decisionId'])
export class AIMessage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  aiConversationId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  conversationId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  decisionId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  messageId!: string | null;

  @Column({ type: 'varchar', length: 16 })
  role!: AIMessageRole;

  @Column({ type: 'text', nullable: true })
  content!: string | null;

  @Column({ type: 'varchar', length: 48, nullable: true })
  provider!: string | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  model!: string | null;

  @Column({ type: 'varchar', length: 24, default: AIJobSlot.DECISION })
  jobSlot!: AIJobSlot;

  @Column({ type: 'int', nullable: true })
  promptTokens!: number | null;

  @Column({ type: 'int', nullable: true })
  completionTokens!: number | null;

  @Column({ type: 'int', nullable: true })
  latencyMs!: number | null;

  @Column({ type: 'varchar', length: 24, nullable: true })
  decision!: string | null;

  /** Self-reported and uncalibrated, exactly as `decision_logs` records it. */
  @Column({ type: 'numeric', precision: 4, scale: 3, nullable: true })
  confidence!: string | null;

  @Column({ type: 'boolean', nullable: true })
  knowledgeSufficient!: boolean | null;

  @Column({ type: 'boolean', nullable: true })
  needsHuman!: boolean | null;

  @Column({ type: 'jsonb', nullable: true })
  citedIds!: string[] | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  error!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
