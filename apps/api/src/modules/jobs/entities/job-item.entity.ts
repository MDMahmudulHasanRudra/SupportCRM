import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Job } from './job.entity';

export enum JobItemStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  SKIPPED = 'SKIPPED',
  CANCELLED = 'CANCELLED',
}

/**
 * One unit inside a job — one group to update, one recipient to message.
 *
 * Per-item rows are what make "482 completed, 18 failed, retry just the 18" possible
 * (`PROJECT_SPEC.md` §50). A job that only tracked aggregate counts could report the numbers but
 * could never tell an operator WHICH ones failed or retry only those.
 *
 * `attempts` is on the item rather than the job because retry is per item: re-running a bulk job
 * must not re-apply the 482 that already succeeded.
 */
@Entity('job_items')
@Index(['jobId', 'status'])
export class JobItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  jobId!: string;

  @ManyToOne(() => Job, (job) => job.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'jobId' })
  job!: Job;

  /** Identifies the target, e.g. a group id or a phone number. Shown verbatim in the error list. */
  @Column({ type: 'varchar', length: 190 })
  reference!: string;

  @Column({ type: 'varchar', length: 24, default: JobItemStatus.PENDING })
  status!: JobItemStatus;

  @Column({ type: 'jsonb', nullable: true })
  payload!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  result!: Record<string, unknown> | null;

  /** User-facing failure reason. `PROJECT_SPEC.md` §122: never fail silently. */
  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'timestamptz', nullable: true })
  processedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
