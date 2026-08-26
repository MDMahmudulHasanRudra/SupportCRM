import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** What a rule did on one message. The raw material for automation health (brief §23). */
export enum ExecutionOutcome {
  MATCHED_WON = 'MATCHED_WON',
  MATCHED_LOST = 'MATCHED_LOST',
  SKIPPED_COOLDOWN = 'SKIPPED_COOLDOWN',
  SKIPPED_LIMIT = 'SKIPPED_LIMIT',
  ACTION_FAILED = 'ACTION_FAILED',
}

@Entity('automation_executions')
@Index(['ruleId', 'createdAt'])
export class AutomationExecution {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  ruleId!: string;

  @Column({ type: 'int' })
  ruleVersion!: number;

  @Column({ type: 'uuid', nullable: true })
  decisionId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  conversationId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  messageId!: string | null;

  @Column({ type: 'varchar', length: 24 })
  outcome!: ExecutionOutcome;

  @Column({ type: 'varchar', length: 500, nullable: true })
  detail!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
