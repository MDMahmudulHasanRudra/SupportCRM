import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { CandidateSource, CandidateStatus, KnowledgeScopeType } from '../knowledge-types';

/**
 * A gap in the knowledge base (`PROJECT_SPEC.md` §75).
 *
 * "Customers keep asking about X and we have nothing written down." In Phase 4 these are raised by
 * people — `sourceType` is always MANUAL. The spec's automatic producer is repeated AI escalation,
 * which does not exist yet; `AI_ESCALATION` is declared so that phase needs no migration, and
 * nothing writes it today.
 *
 * Converting a candidate creates a **DRAFT** article. It never publishes anything: what goes in
 * front of a customer stays a human decision.
 */
@Entity('knowledge_candidates')
export class KnowledgeCandidate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 500 })
  question!: string;

  @Column({ type: 'text', nullable: true })
  context!: string | null;

  @Column({ type: 'varchar', length: 24, default: CandidateSource.MANUAL })
  sourceType!: CandidateSource;

  /** Bumped when the same gap is reported again, so the queue can be ordered by real demand. */
  @Column({ type: 'int', default: 1 })
  occurrences!: number;

  @Index()
  @Column({ type: 'varchar', length: 16, default: CandidateStatus.OPEN })
  status!: CandidateStatus;

  @Column({ type: 'uuid', nullable: true })
  categoryId!: string | null;

  @Column({ type: 'varchar', length: 16, default: KnowledgeScopeType.GLOBAL })
  scopeType!: KnowledgeScopeType;

  @Column({ type: 'uuid', nullable: true })
  scopeId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  convertedArticleId!: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  resolutionNote!: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdById!: string | null;

  @Column({ type: 'uuid', nullable: true })
  resolvedById!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
