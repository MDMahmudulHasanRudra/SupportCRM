import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ParticipantRole, ParticipantType } from '../../messaging/message-types';
import { Group } from './group.entity';

/**
 * One member of a group (Phase 2 brief §8).
 *
 * `participantType` defaults to `UNKNOWN` and is only ever promoted to `TEAM_MEMBER` or `ACCOUNT`
 * by evidence we hold — a configured `team_member_identities` row, or the connected account's own
 * number. **Nothing in Phase 2 sets `CUSTOMER`.** The brief is explicit that a WhatsApp participant
 * is not automatically a customer; that determination belongs to Phase 3's matching layer, which
 * will have the customer records to match against. Guessing here would create thousands of wrong
 * customer associations that later work would have to unpick.
 *
 * Rows are kept when someone leaves (`isActive = false`) so historical attribution still resolves.
 */
@Entity('group_participants')
@Index(['groupId', 'externalId'], { unique: true })
@Index(['groupId', 'isActive'])
export class GroupParticipant {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  groupId!: string;

  @ManyToOne(() => Group, (group) => group.participants, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'groupId' })
  group!: Group;

  /** The provider's participant identifier. */
  @Column({ type: 'varchar', length: 190 })
  externalId!: string;

  /** Digits only. Untrusted; normalised and length-capped on the way in. */
  @Index()
  @Column({ type: 'varchar', length: 32, nullable: true })
  phone!: string | null;

  /** Provider-supplied display name. Untrusted. */
  @Column({ type: 'varchar', length: 190, nullable: true })
  displayName!: string | null;

  @Column({ type: 'varchar', length: 16, default: ParticipantRole.MEMBER })
  role!: ParticipantRole;

  @Column({ type: 'varchar', length: 16, default: ParticipantType.UNKNOWN })
  participantType!: ParticipantType;

  /** Set when `participantType` is TEAM_MEMBER, linking to the Support CRM user. */
  @Column({ type: 'uuid', nullable: true })
  teamMemberIdentityId!: string | null;

  /** False once they leave. The row is retained for attribution. */
  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  lastSeenInSyncAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
