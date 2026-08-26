import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { AutomationStatus } from '../automation-types';

/**
 * A reusable bundle of automation settings (`PROJECT_SPEC.md` §42, §44; brief §29).
 *
 * The reason this exists rather than per-group configuration: the system is specified for 3,000+
 * groups. Assigning 2,400 of them to "ISP Standard Support" and editing that profile once is the
 * only way an administrator can actually operate it.
 *
 * Null on an override means "inherit the global setting". A profile states only what it changes.
 */
@Entity('automation_profiles')
export class AutomationProfile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'varchar', length: 16, default: AutomationStatus.DRAFT })
  status!: AutomationStatus;

  @Column({ type: 'int', default: 1 })
  currentVersion!: number;

  @Column({ type: 'boolean', default: false })
  aiEnabled!: boolean;

  @Column({ type: 'boolean', default: true })
  automationEnabled!: boolean;

  @Column({ type: 'uuid', nullable: true })
  knowledgeProfileId!: string | null;

  /** Stored as numeric(4,3); pg returns numerics as strings, so these are parsed where used. */
  @Column({ type: 'numeric', precision: 4, scale: 3, nullable: true })
  autoReplyMinConfidence!: string | null;

  @Column({ type: 'numeric', precision: 4, scale: 3, nullable: true })
  escalateBelowConfidence!: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  midConfidencePolicy!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  escalationPolicy!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  businessHours!: { timezone?: string; days: Record<string, { from: string; to: string }> } | null;

  /** How long a human takeover holds before it lapses. Null means it holds until released. */
  @Column({ type: 'int', nullable: true })
  humanTakeoverMinutes!: number | null;

  @Column({ type: 'uuid', nullable: true })
  assignedTeamId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdById!: string | null;

  @Column({ type: 'uuid', nullable: true })
  updatedById!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
