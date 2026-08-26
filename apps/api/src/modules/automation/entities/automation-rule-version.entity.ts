import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { AutomationStatus } from '../automation-types';

/** An immutable snapshot of a rule, so a rollback restores rather than reconstructs. */
@Entity('automation_rule_versions')
export class AutomationRuleVersion {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  ruleId!: string;

  @Column({ type: 'int' })
  version!: number;

  @Column({ type: 'jsonb' })
  snapshot!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 16 })
  status!: AutomationStatus;

  @Column({ type: 'varchar', length: 500, nullable: true })
  changeSummary!: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdById!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
