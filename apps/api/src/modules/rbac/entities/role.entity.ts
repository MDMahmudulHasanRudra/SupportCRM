import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinTable,
  ManyToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Permission } from './permission.entity';

/**
 * A named set of permissions (`PROJECT_SPEC.md` §108).
 *
 * Users hold roles; roles hold permissions. The seven roles the spec names are seeded with
 * `isSystem = true`, which blocks rename and delete but leaves their permission sets editable —
 * an operator can tighten "Support Executive" without being able to delete the role that half the
 * team depends on.
 */
@Entity('roles')
export class Role {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Stable machine key, e.g. `support_executive`. Referenced by the seed; never renamed. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  key!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  /** Seeded roles: protected from rename/delete, permissions still editable. */
  @Column({ type: 'boolean', default: false })
  isSystem!: boolean;

  /**
   * Bypasses every permission check. Exactly one seeded role (`super_admin`) has this, and the
   * seed refuses to create a second — without it, a permission catalogue change could lock every
   * human out of the system with no way back in.
   */
  @Column({ type: 'boolean', default: false })
  isSuperAdmin!: boolean;

  @ManyToMany(() => Permission, (permission) => permission.roles, { eager: false })
  @JoinTable({
    name: 'role_permissions',
    joinColumn: { name: 'role_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'permission_id', referencedColumnName: 'id' },
  })
  permissions!: Permission[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
