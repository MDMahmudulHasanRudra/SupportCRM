import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Singleton settings row (`PROJECT_SPEC.md` §178).
 *
 * The single-row pattern is carried over from the prior system: one row with a fixed primary key,
 * so the values are editable, auditable and migratable like any other data — rather than living in
 * environment variables, where changing a lockout threshold would need a redeploy and would leave
 * no audit trail of who changed it.
 */
export const SECURITY_SETTINGS_ID = 'singleton';

@Entity('security_settings')
export class SecuritySettings {
  @PrimaryColumn({ type: 'varchar', length: 16, default: SECURITY_SETTINGS_ID })
  id!: string;

  /** Consecutive failures inside the window before the account locks. */
  @Column({ type: 'int', default: 5 })
  loginLockoutThreshold!: number;

  /** Rolling window for counting failures. */
  @Column({ type: 'int', default: 15 })
  loginLockoutWindowMinutes!: number;

  /** How long a locked account stays locked. */
  @Column({ type: 'int', default: 15 })
  loginLockoutDurationMinutes!: number;

  @Column({ type: 'int', default: 12 })
  sessionLifetimeHours!: number;

  @Column({ type: 'int', default: 8 })
  passwordMinLength!: number;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
