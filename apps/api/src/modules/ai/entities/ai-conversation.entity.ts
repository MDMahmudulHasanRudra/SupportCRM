import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * The AI's memory of one conversation (`PROJECT_SPEC.md` §25, §26).
 *
 * The medium-term half: a rolling summary rewritten as the thread grows, so a long conversation
 * costs a bounded number of tokens instead of an unbounded one. The summary records the issue, what
 * has been attempted, the current state, what is unresolved, decisions a human made, knowledge used
 * and escalation status — never the transcript, which the inbox already holds.
 */
@Entity('ai_conversations')
export class AIConversation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'uuid' })
  conversationId!: string;

  @Column({ type: 'text', nullable: true })
  summary!: string | null;

  @Column({ type: 'int', nullable: true })
  summaryTokens!: number | null;

  /** Everything up to and including this message is represented by `summary`. */
  @Column({ type: 'uuid', nullable: true })
  summarizedThroughMessageId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  summarizedAt!: Date | null;

  @Column({ type: 'int', default: 0 })
  turnCount!: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastTurnAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
