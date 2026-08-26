import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { AIFeedbackVerdict } from '../ai-types';

/**
 * A human's verdict on one AI turn (`PROJECT_SPEC.md` §88, §136).
 *
 * An edit recorded here never rewrites production knowledge. It becomes evidence for a candidate
 * that a person reviews — the learning loop — because "the AI said something wrong and an agent
 * corrected it in the moment" is a signal, not an approval.
 */
@Entity('ai_feedback')
@Index(['verdict', 'createdAt'])
export class AIFeedback {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  aiMessageId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  decisionId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  conversationId!: string | null;

  @Column({ type: 'varchar', length: 16 })
  verdict!: AIFeedbackVerdict;

  @Column({ type: 'text', nullable: true })
  correctedText!: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  note!: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdById!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
