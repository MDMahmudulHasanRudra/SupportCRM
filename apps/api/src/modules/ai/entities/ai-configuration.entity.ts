import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { AIConfigScope, AIJobSlot } from '../ai-types';

/**
 * Which model answers, and in what voice (`PROJECT_SPEC.md` §23, §24).
 *
 * Layered Global → Support Profile → Group, more specific overriding broader — and every field is
 * nullable so a scope states only what it changes. A group that wants Bangla and nothing else says
 * exactly that, and keeps the global model, tone and instructions.
 *
 * One row per (scope, scopeId, job slot), enforced by a unique index. Two rows claiming the same
 * scope would make "which model answers this group?" a question with more than one answer.
 */
@Entity('ai_configurations')
@Index(['scopeType', 'scopeId'])
export class AIConfiguration {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 16, default: AIConfigScope.GLOBAL })
  scopeType!: AIConfigScope;

  @Column({ type: 'uuid', nullable: true })
  scopeId!: string | null;

  @Column({ type: 'varchar', length: 24, default: AIJobSlot.DECISION })
  jobSlot!: AIJobSlot;

  @Column({ type: 'uuid', nullable: true })
  providerId!: string | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  model!: string | null;

  @Column({ type: 'numeric', precision: 3, scale: 2, nullable: true })
  temperature!: string | null;

  @Column({ type: 'int', nullable: true })
  maxTokens!: number | null;

  @Column({ type: 'varchar', length: 24, nullable: true })
  tone!: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  language!: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  answerLength!: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  emojiLevel!: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  technicalLevel!: string | null;

  /**
   * Extra guidance for this scope.
   *
   * Layered rather than replaced: a group's instructions are appended to the global ones, because
   * a group operator who writes "mention the Dhaka office hours" should not thereby drop the
   * company-wide rule about never quoting prices.
   */
  @Column({ type: 'text', nullable: true })
  systemInstructions!: string | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'uuid', nullable: true })
  createdById!: string | null;

  @Column({ type: 'uuid', nullable: true })
  updatedById!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
