import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinTable,
  ManyToMany,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Role } from '../../rbac/entities/role.entity';
import { UserSession } from './user-session.entity';

/**
 * A human operator of Support CRM.
 *
 * Distinct from `team_members` (Phase 3), which are the WhatsApp identities of support staff — a
 * support executive who never logs into the dashboard has a team member row and no user row, and a
 * back-office admin has the reverse. Conflating them was a modelling mistake worth avoiding early.
 *
 * Users are never hard-deleted (`isActive = false` instead), so audit history keeps a valid actor
 * reference. Deactivation is enforced at login AND on every already-issued session.
 */
@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  username!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 255 })
  email!: string;

  @Column({ type: 'varchar', length: 160 })
  name!: string;

  /**
   * scrypt `salt:hash`. Never selected by default: a stray `find()` that logs its result or returns
   * it from a controller cannot leak the hash, because it is not in the object at all.
   */
  @Column({ type: 'varchar', length: 255, select: false })
  passwordHash!: string;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  lastLoginAt!: Date | null;

  /** Reset to 0 on every successful login. */
  @Column({ type: 'int', default: 0 })
  failedLoginAttempts!: number;

  /**
   * Dedicated timestamp for the lockout window — deliberately not `updatedAt`, which changes for
   * unrelated reasons (an admin editing the user) and would make the rolling window unreliable.
   */
  @Column({ type: 'timestamptz', nullable: true })
  lastFailedLoginAt!: Date | null;

  /** Set once failures cross the configured threshold inside the window; checked before the password. */
  @Column({ type: 'timestamptz', nullable: true })
  lockedUntil!: Date | null;

  @ManyToMany(() => Role, { eager: true })
  @JoinTable({
    name: 'user_roles',
    joinColumn: { name: 'user_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'role_id', referencedColumnName: 'id' },
  })
  roles!: Role[];

  @OneToMany(() => UserSession, (session) => session.user)
  sessions!: UserSession[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
