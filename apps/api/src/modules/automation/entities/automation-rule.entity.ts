import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import {
  AutomationStatus,
  RuleOrigin,
  RuleScopeType,
  type RuleAction,
  type RuleConditionSet,
} from '../automation-types';

/**
 * One deterministic rule.
 *
 * `conditions` and `actions` are **data** — typed structures interpreted by `RuleEvaluator`. There
 * is no code path that executes anything stored here.
 */
@Entity('automation_rules')
@Index(['status', 'scopeType', 'scopeId'])
export class AutomationRule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  profileId!: string | null;

  @Column({ type: 'varchar', length: 160 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'varchar', length: 16, default: AutomationStatus.DRAFT })
  status!: AutomationStatus;

  @Column({ type: 'int', default: 1 })
  currentVersion!: number;

  @Column({ type: 'int', default: 0 })
  priority!: number;

  @Column({ type: 'varchar', length: 16, default: RuleScopeType.GLOBAL })
  scopeType!: RuleScopeType;

  @Column({ type: 'uuid', nullable: true })
  scopeId!: string | null;

  @Column({ type: 'jsonb', default: () => `'{"match":"ALL","conditions":[]}'::jsonb` })
  conditions!: RuleConditionSet;

  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  actions!: RuleAction[];

  @Column({ type: 'int', default: 0 })
  cooldownSeconds!: number;

  @Column({ type: 'int', nullable: true })
  maxExecutions!: number | null;

  @Column({ type: 'int', default: 0 })
  executionCount!: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastMatchedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  effectiveFrom!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  effectiveUntil!: Date | null;

  /** AI-suggested rules are created DRAFT and never activate without a human (brief §25). */
  @Column({ type: 'varchar', length: 16, default: RuleOrigin.HUMAN })
  origin!: RuleOrigin;

  @Column({ type: 'uuid', nullable: true })
  createdById!: string | null;

  @Column({ type: 'uuid', nullable: true })
  updatedById!: string | null;

  @Column({ type: 'uuid', nullable: true })
  approvedById!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  approvedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
