import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * The audit trail (`PROJECT_SPEC.md` §107).
 *
 * Distinct from application logging: logs are for debugging and may be sampled, rotated or dropped;
 * audit rows answer "who changed this, when, from what, to what" and are business records.
 *
 * Three properties this table must keep:
 *  - **Append-only.** No update or delete path is exposed. `AuditService` writes; nothing edits.
 *  - **Actor survives deletion.** `actorId` is a plain uuid column with no foreign key, and the
 *    username is denormalised alongside it, so the row stays readable and no audit entry can ever
 *    block a user row from being removed.
 *  - **Never contains secrets.** `before`/`after` go through `redact()` before they are written.
 */
@Entity('audit_logs')
@Index(['resource', 'resourceId'])
@Index(['actorId', 'createdAt'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Null for actions the system took on its own (a scheduled job, a webhook-driven change). */
  @Column({ type: 'uuid', nullable: true })
  actorId!: string | null;

  /** Denormalised so the entry stays meaningful if the user is later renamed or removed. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  actorUsername!: string | null;

  /** Dotted action key, e.g. `auth.login`, `settings.update`, `system.emergency_stop`. */
  @Index()
  @Column({ type: 'varchar', length: 100 })
  action!: string;

  /** Resource type, e.g. `user`, `role`, `setting`, `job`. */
  @Column({ type: 'varchar', length: 64 })
  resource!: string;

  @Column({ type: 'varchar', length: 128, nullable: true })
  resourceId!: string | null;

  /** Redacted snapshot before the change. Null for creates. */
  @Column({ type: 'jsonb', nullable: true })
  before!: Record<string, unknown> | null;

  /** Redacted snapshot after the change. Null for deletes. */
  @Column({ type: 'jsonb', nullable: true })
  after!: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ipAddress!: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  userAgent!: string | null;

  /** Free-form context: request id, job id, reason, blast radius of a bulk action. Redacted. */
  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  /** False when the audited action itself failed — a denied attempt is worth recording too. */
  @Column({ type: 'boolean', default: true })
  success!: boolean;

  @Index()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
