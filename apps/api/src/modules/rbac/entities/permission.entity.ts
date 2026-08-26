import { Column, Entity, Index, ManyToMany, PrimaryGeneratedColumn } from 'typeorm';
import { Role } from './role.entity';

/**
 * A real table, not a TypeScript enum.
 *
 * Rows are seeded from `permissions.catalogue.ts`, which is the single source of truth. Because
 * `role_permissions` carries a foreign key to this table, a mistyped permission key fails closed
 * against a constraint instead of silently granting or denying access — the pattern the prior
 * system proved out, carried over deliberately (`docs/adr/0001` §3).
 */
@Entity('permissions')
export class Permission {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** e.g. `groups.bulk_update` — the string used in `@RequirePermissions()`. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 100 })
  key!: string;

  @Column({ type: 'varchar', length: 160 })
  label!: string;

  /** Groups permissions in the admin UI, e.g. "Automation", "AI", "System". */
  @Column({ type: 'varchar', length: 80 })
  category!: string;

  /**
   * True for permissions that can cause irreversible or wide-blast-radius effects (emergency stop,
   * bulk updates, broadcast send). Surfaced in the UI and required by the AI Copilot's
   * confirmation flow in Phase 10 (`PROJECT_SPEC.md` §90).
   */
  @Column({ type: 'boolean', default: false })
  isDangerous!: boolean;

  @ManyToMany(() => Role, (role) => role.permissions)
  roles!: Role[];
}
