import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export enum BroadcastStatus {
  DRAFT = 'DRAFT',
  SCHEDULED = 'SCHEDULED',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED',
}

/**
 * A campaign (brief §27).
 *
 * The recipients are Job Center items rather than rows here: the Job Center already gives per-item
 * progress, per-item failure, retry-failed and cancellation, and duplicating that would mean two
 * places to keep correct.
 */
@Entity('broadcasts')
@Index(['status', 'createdAt'])
export class Broadcast {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 160 })
  name!: string;

  @Column({ type: 'text' })
  body!: string;

  @Column({ type: 'uuid' })
  channelAccountId!: string;

  /** What was targeted, as data — resolved to job items when the campaign starts. */
  @Column({ type: 'jsonb' })
  target!: { groupIds?: string[]; conversationIds?: string[] };

  @Column({ type: 'varchar', length: 16, default: BroadcastStatus.DRAFT })
  status!: BroadcastStatus;

  @Column({ type: 'uuid', nullable: true })
  jobId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  scheduledAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  startedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @Column({ type: 'int', default: 0 })
  totalCount!: number;

  @Column({ type: 'int', default: 0 })
  successCount!: number;

  @Column({ type: 'int', default: 0 })
  failureCount!: number;

  @Column({ type: 'int', default: 0 })
  cancelledCount!: number;

  /** Recipients excluded before sending — opted out, unreachable, or no address (§195). */
  @Column({ type: 'int', default: 0 })
  skippedCount!: number;

  @Column({ type: 'varchar', length: 24, nullable: true })
  mediaType!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  mediaRef!: string | null;

  /** When a test send went out, so "did I check this before sending it to 2,000 people?" is answerable. */
  @Column({ type: 'timestamptz', nullable: true })
  testSentAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  createdById!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
