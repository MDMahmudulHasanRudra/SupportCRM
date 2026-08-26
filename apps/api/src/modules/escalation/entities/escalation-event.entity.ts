import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum EscalationEventKind {
  NOTIFY_INTERNAL_GROUP = 'NOTIFY_INTERNAL_GROUP',
  NOTIFY_EXECUTIVE = 'NOTIFY_EXECUTIVE',
  NOTIFY_CUSTOMER = 'NOTIFY_CUSTOMER',
  DASHBOARD = 'DASHBOARD',
}

export enum EscalationEventStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  FAILED = 'FAILED',
  SKIPPED = 'SKIPPED',
}

/**
 * One notification attempt for one escalation (`PROJECT_SPEC.md` §29, §33, §34).
 *
 * `UNIQUE (escalationId, kind, target)` is the whole point of this table. Telling the support group
 * that a customer is waiting is exactly the side effect that gets sent twice — a retried job, a
 * redelivered webhook, two workers racing — and "we already notified them" has to be a fact the
 * database enforces, not a flag the code hopes it checked.
 *
 * The row is claimed first and sent afterwards, the same shape `decision_logs` uses: losing the
 * insert means somebody else owns this notification, so this worker stops.
 */
@Entity('escalation_events')
@Index(['status', 'createdAt'])
export class EscalationEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  escalationId!: string;

  @Column({ type: 'varchar', length: 32 })
  kind!: EscalationEventKind;

  /** A group id, a user id, or the literal `dashboard`. Part of the uniqueness. */
  @Column({ type: 'varchar', length: 190 })
  target!: string;

  @Column({ type: 'varchar', length: 16, default: EscalationEventStatus.PENDING })
  status!: EscalationEventStatus;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  detail!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
