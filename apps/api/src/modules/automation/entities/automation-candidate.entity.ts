import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import type { RuleAction, RuleConditionSet } from '../automation-types';

export enum CandidateStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  PUBLISHED = 'PUBLISHED',
}

/**
 * A proposed rule, awaiting a human (`PROJECT_SPEC.md` §85–§88, §135, §136).
 *
 * The pipeline is conversation → pattern → candidate → **review** → approval → production, and this
 * table is the step that cannot be skipped. A candidate has no path to a customer: it is not
 * evaluated, it has no status the engine recognises, and turning it into a live rule means writing
 * a row in `automation_rules` — which arrives as a DRAFT and needs its own approval on top.
 *
 * That is two humans' worth of friction between "the system noticed a pattern" and "the system says
 * this to customers", and §86 is explicit that automatic publication is not acceptable. High-
 * confidence auto-activation exists as an advanced setting and is **off by default**.
 */
@Entity('automation_candidates')
@Index(['status', 'occurrences'])
export class AutomationCandidate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  /** Why this was proposed, in words a reviewer can judge without reading the source rows. */
  @Column({ type: 'text', nullable: true })
  rationale!: string | null;

  @Column({ type: 'varchar', length: 24, default: 'PATTERN' })
  source!: 'PATTERN' | 'AI_SUGGESTED' | 'FEEDBACK' | 'MANUAL';

  @Column({ type: 'jsonb', nullable: true })
  proposedConditions!: RuleConditionSet | null;

  @Column({ type: 'jsonb', nullable: true })
  proposedActions!: RuleAction[] | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  scopeType!: string | null;

  @Column({ type: 'uuid', nullable: true })
  scopeId!: string | null;

  /** Evidence. Seen twice is a coincidence; seen forty times is a gap worth closing. */
  @Column({ type: 'int', default: 1 })
  occurrences!: number;

  @Column({ type: 'jsonb', nullable: true })
  sampleMessageIds!: string[] | null;

  @Column({ type: 'varchar', length: 16, default: CandidateStatus.PENDING })
  status!: CandidateStatus;

  /** Set after a human published it. One-way and after the fact. */
  @Column({ type: 'uuid', nullable: true })
  publishedRuleId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  reviewedById!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt!: Date | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  reviewNote!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
