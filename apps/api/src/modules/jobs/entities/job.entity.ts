import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { JobItem } from './job-item.entity';

/**
 * A unit of asynchronous work with per-item progress (`PROJECT_SPEC.md` §49–51).
 *
 * One generic Job Center, not a bespoke table per feature. The prior system grew
 * `GroupBroadcastJob`, `GroupParticipantAddJob` and `LearningBatchJob` as three near-identical
 * shapes with three near-identical processors; every new bulk feature meant another migration and
 * another progress UI. This table is the shared substrate for all of them.
 *
 * Division of labour with Redis: BullMQ moves the work and handles retry timing; this row is the
 * durable record — what was requested, by whom, how far it got, and what failed. Redis can be
 * flushed and the job history survives (`PROJECT_SPEC.md` §184).
 */
export enum JobType {
  WHATSAPP_ACTION = 'WHATSAPP_ACTION',
  WHATSAPP_INTEGRATION_SYNC='WHATSAPP_INTEGRATION_SYNC',
  /** Real, exercised in Phase 1 — proves the whole pipeline without waiting for a domain feature. */
  SYSTEM_ECHO = 'SYSTEM_ECHO',
  /** One item per group: fetch its detail from the channel and reconcile participants. */
  CHANNEL_PARTICIPANT_SYNC = 'CHANNEL_PARTICIPANT_SYNC',
  BULK_GROUP_UPDATE = 'BULK_GROUP_UPDATE',
  BROADCAST = 'BROADCAST',
  MEMBER_OPERATION = 'MEMBER_OPERATION',
  KNOWLEDGE_INDEX = 'KNOWLEDGE_INDEX',
  REPORT_GENERATE = 'REPORT_GENERATE',
  EXPORT = 'EXPORT',
}

export enum JobStatus {
  QUEUED = 'QUEUED',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  /** Finished, but at least one item failed. Distinct from FAILED so partial success is visible. */
  COMPLETED_WITH_ERRORS = 'COMPLETED_WITH_ERRORS',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

@Entity('jobs')
@Index(['status', 'createdAt'])
export class Job {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 48 })
  type!: JobType;

  @Index()
  @Column({ type: 'varchar', length: 32, default: JobStatus.QUEUED })
  status!: JobStatus;

  @Column({ type: 'varchar', length: 160 })
  name!: string;

  /**
   * Caller-supplied key making enqueue idempotent (`PROJECT_SPEC.md` §117). A double-clicked
   * "Start job" button with the same key returns the existing job instead of creating a second.
   * Unique index is partial (`WHERE "idempotencyKey" IS NOT NULL`) — see the migration.
   */
  @Column({ type: 'varchar', length: 128, nullable: true })
  idempotencyKey!: string | null;

  /** Job-type-specific input. Redacted before it is ever logged or audited. */
  @Column({ type: 'jsonb', nullable: true })
  payload!: Record<string, unknown> | null;

  @Column({ type: 'int', default: 0 })
  totalItems!: number;

  @Column({ type: 'int', default: 0 })
  completedItems!: number;

  @Column({ type: 'int', default: 0 })
  failedItems!: number;

  /** Set when the job as a whole failed — an item failure lives on the item, not here. */
  @Column({ type: 'text', nullable: true })
  error!: string | null;

  /** Co-operative cancellation: the processor checks this between items (§50). */
  @Column({ type: 'boolean', default: false })
  cancelRequested!: boolean;

  @Column({ type: 'uuid', nullable: true })
  createdById!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  startedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;

  @OneToMany(() => JobItem, (item) => item.job)
  items!: JobItem[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  /** Percentage for the UI. Computed, never stored — a stored copy would drift. */
  get progressPercent(): number {
    if (this.totalItems === 0) return this.status === JobStatus.QUEUED ? 0 : 100;
    return Math.round(((this.completedItems + this.failedItems) / this.totalItems) * 1000) / 10;
  }
}
