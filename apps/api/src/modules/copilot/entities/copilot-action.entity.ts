import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum CopilotActionStatus {
  PROPOSED = 'PROPOSED',
  EXECUTED = 'EXECUTED',
  CONFIRMED = 'CONFIRMED',
  REJECTED = 'REJECTED',
  FAILED = 'FAILED',
  EXPIRED = 'EXPIRED',
}

/**
 * One thing the Copilot did, or offered to do (`PROJECT_SPEC.md` §89-§91, §138).
 *
 * Written for reads as well as writes. A read is cheap to record and expensive to reconstruct, and
 * "who asked the assistant for the customer list" is a question worth being able to answer.
 */
@Entity('copilot_actions')
@Index(['status', 'createdAt'])
export class CopilotAction {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  userId!: string | null;

  @Column({ type: 'text' })
  prompt!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  tool!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  arguments!: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 16, default: 'READ' })
  kind!: 'READ' | 'WRITE';

  @Column({ type: 'varchar', length: 24, default: CopilotActionStatus.PROPOSED })
  status!: CopilotActionStatus;

  /** Stated before confirmation: "this affects 500 groups", in words an operator can act on. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  blastRadius!: string | null;

  @Column({ type: 'uuid', nullable: true })
  confirmedById!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  confirmedAt!: Date | null;

  @Column({ type: 'varchar', length: 2000, nullable: true })
  result!: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  error!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
