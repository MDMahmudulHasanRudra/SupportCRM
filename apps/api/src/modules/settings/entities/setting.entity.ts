import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export enum SettingValueType {
  STRING = 'string',
  NUMBER = 'number',
  BOOLEAN = 'boolean',
  JSON = 'json',
  /** Stored as an AES-256-GCM envelope; never returned in plaintext by any API. */
  SECRET = 'secret',
}

/**
 * Runtime configuration (`PROJECT_SPEC.md` §125) and feature flags (§124).
 *
 * Environment variables configure the PROCESS — where the database is, which port to bind. This
 * table configures the PRODUCT — thresholds, policies, flags — because those must be changeable by
 * an admin, auditable, and effective without a redeploy. Confusing the two is why the prior system
 * needed a container restart to change a rate limit.
 *
 * Secrets stored here (the gateway API key, AI provider keys) are encrypted at rest and read back
 * only by server-side code. `SettingsService.getPublic()` never returns a SECRET's value.
 */
@Entity('settings')
export class Setting {
  /** Dotted key, e.g. `ai.default_confidence_threshold`, `feature.broadcast_enabled`. */
  @PrimaryColumn({ type: 'varchar', length: 128 })
  key!: string;

  /** Ciphertext when `valueType` is SECRET; the serialized value otherwise. */
  @Column({ type: 'text', nullable: true })
  value!: string | null;

  @Column({ type: 'varchar', length: 16, default: SettingValueType.STRING })
  valueType!: SettingValueType;

  @Column({ type: 'varchar', length: 64, default: 'general' })
  category!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  /**
   * False for operational settings an admin may read in the UI; SECRET rows are always non-public
   * regardless. Guards against a future endpoint accidentally dumping the whole table.
   */
  @Column({ type: 'boolean', default: true })
  isPublic!: boolean;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ type: 'uuid', nullable: true })
  updatedById!: string | null;
}
