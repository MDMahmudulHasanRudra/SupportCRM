import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum AiRunStatus {
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  TIMEOUT = 'TIMEOUT',
  RATE_LIMITED = 'RATE_LIMITED',
  UNAVAILABLE = 'UNAVAILABLE',
}

/**
 * One call to an AI provider.
 *
 * Records that it happened, how long it took and how it ended — never the prompt or the response.
 * The prompt contains customer content and the retrieved knowledge; storing it here would duplicate
 * both into a table with wider read access than either.
 */
@Entity('ai_runs')
@Index(['createdAt'])
export class AiRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  decisionId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  conversationId!: string | null;

  @Column({ type: 'varchar', length: 24, default: 'DECISION' })
  purpose!: string;

  @Column({ type: 'varchar', length: 48, nullable: true })
  provider!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  model!: string | null;

  @Column({ type: 'varchar', length: 16 })
  status!: AiRunStatus;

  @Column({ type: 'int', nullable: true })
  promptTokens!: number | null;

  @Column({ type: 'int', nullable: true })
  completionTokens!: number | null;

  @Column({ type: 'int', nullable: true })
  latencyMs!: number | null;

  @Column({ type: 'numeric', precision: 4, scale: 3, nullable: true })
  confidence!: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  error!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
