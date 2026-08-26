import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ChannelKey } from '../../channel/entities/channel.entity';

/**
 * Maps a Support CRM user to their identity on a channel (Phase 2 brief §9).
 *
 * This is the join that makes message classification possible: without it, a support executive
 * answering in a WhatsApp group is indistinguishable from a customer asking a question, and both
 * the decision engine and Support Activity would be wrong about every message.
 *
 * Modelled as its own table rather than a column on `users` because the relationship is genuinely
 * one-to-many: one person can have a personal number and a desk number, and a channel identity can
 * outlive the account it was first seen on.
 *
 * **What this table does NOT do:** it does not, by itself, mean every message from this identity is
 * support activity. The brief is explicit on that point, and `PROJECT_SPEC.md` §68 makes activity a
 * function of rules and context, not of sender identity alone. Phase 2 only establishes who is
 * internal; Phase 3 decides what counts.
 *
 * `userId` is nullable so a team member who never logs into the dashboard can still be registered —
 * they exist on WhatsApp, which is the only place their messages appear.
 */
@Entity('team_member_identities')
@Index(['channelKey', 'externalId'], { unique: true })
@Index(['channelKey', 'phone'], { unique: true })
export class TeamMemberIdentity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The Support CRM user, when this person has a dashboard login. */
  @Column({ type: 'uuid', nullable: true })
  userId!: string | null;

  @Column({ type: 'varchar', length: 32 })
  channelKey!: ChannelKey;

  /**
   * The provider identity, e.g. a WhatsApp JID. Normalised by the adapter before storage so a
   * lookup is an exact indexed match and never a fuzzy comparison.
   */
  @Column({ type: 'varchar', length: 190 })
  externalId!: string;

  /**
   * Digits only, no `+`. This is the practical lookup key: an inbound message carries a phone more
   * reliably than a stable JID, and an admin registering a colleague knows their number, not their
   * JID. Unique per channel so one number cannot be claimed by two people.
   */
  @Column({ type: 'varchar', length: 32 })
  phone!: string;

  @Column({ type: 'varchar', length: 160 })
  displayName!: string;

  /** Free-text role label for reporting. Not an RBAC role — those live on `users`. */
  @Column({ type: 'varchar', length: 80, nullable: true })
  jobRole!: string | null;

  /**
   * Inactive identities stop classifying new messages as TEAM_MESSAGE but are never deleted, so
   * historical classification stays explicable.
   */
  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
