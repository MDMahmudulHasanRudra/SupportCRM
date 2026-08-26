import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './user.entity';

/**
 * A server-side, revocable login session (`PROJECT_SPEC.md` §178).
 *
 * The cookie carries only a 256-bit random secret. Only its SHA-256 is stored here, so:
 *  - a database dump does not yield usable session cookies, and
 *  - lookup is an indexed equality match on `secretHash`, never a scan.
 *
 * A stateless signed token would be simpler but gives an admin no way to force a logout, which the
 * spec requires. `expiresAt` is baked in at creation from the configured lifetime and never
 * recalculated — changing the setting affects only sessions created afterwards.
 */
@Entity('user_sessions')
export class UserSession {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, (user) => user.sessions, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  /** SHA-256 of the cookie secret. The raw secret is never persisted anywhere. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  secretHash!: string;

  @Index()
  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  /** Set on explicit logout or admin revocation. A revoked session is rejected even before expiry. */
  @Column({ type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  /** Throttled — refreshed at most once every few minutes, or every request would be a write. */
  @Column({ type: 'timestamptz', nullable: true })
  lastUsedAt!: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ipAddress!: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  userAgent!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
