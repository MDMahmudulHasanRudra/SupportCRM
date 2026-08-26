import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ChannelKey } from '../../channel/entities/channel.entity';
import { GroupParticipant } from './group-participant.entity';

/**
 * Monitoring posture (`PROJECT_SPEC.md` §46). Determines whether a group's messages take part in
 * support processing at all — the outermost gate, checked before any engine.
 */
export enum GroupMonitoringState {
  MONITORED = 'MONITORED',
  UNMONITORED = 'UNMONITORED',
  PAUSED = 'PAUSED',
}

/**
 * A group conversation on a channel.
 *
 * `PROJECT_SPEC.md` §44. Phase 2 establishes identity, membership and the three control flags;
 * support profiles, knowledge profiles, escalation config, assigned executives and tags attach in
 * later phases. The flags exist now because a group must be able to arrive `UNMONITORED` with AI
 * and automation off — the safe default — long before there is any AI to switch on. A group that
 * defaulted to monitored would start participating in support the moment the engines land.
 *
 * Never hard-deleted: `isActive` goes false when a sync no longer sees it, so message history keeps
 * a valid `groupId` and the record of what happened survives leaving the group.
 */
@Entity('groups')
@Index(['channelAccountId', 'externalId'], { unique: true })
@Index(['channelAccountId', 'isActive'])
export class Group {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 32 })
  channelKey!: ChannelKey;

  @Column({ type: 'uuid' })
  channelAccountId!: string;

  /** The provider's group identifier. */
  @Column({ type: 'varchar', length: 190 })
  externalId!: string;

  /** Provider-supplied. Fully untrusted input — escape on render, never interpolate into a query. */
  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  /**
   * From the last full sync. Nullable because the provider's cheap listing endpoint does not return
   * it — only the per-group detail call does, which is why participant sync is a separate pass.
   */
  @Column({ type: 'int', nullable: true })
  participantCount!: number | null;

  /** The provider id of the group owner, where exposed. */
  @Column({ type: 'varchar', length: 190, nullable: true })
  ownerExternalId!: string | null;

  /** False once a sync no longer returns this group. Soft-deactivation only. */
  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  /** Only admins may post. Affects whether outbound sends can succeed at all. */
  @Column({ type: 'boolean', default: false })
  isAnnounceOnly!: boolean;

  @Index()
  @Column({ type: 'varchar', length: 16, default: GroupMonitoringState.UNMONITORED })
  monitoringState!: GroupMonitoringState;

  /** Opt-in, default off. No AI exists yet; the flag must predate it so nothing switches on by surprise. */
  @Column({ type: 'boolean', default: false })
  aiEnabled!: boolean;

  /** Opt-in, default off, for the same reason. */
  @Column({ type: 'boolean', default: false })
  automationEnabled!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  lastSyncedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  participantsSyncedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastMessageAt!: Date | null;

  @OneToMany(() => GroupParticipant, (participant) => participant.group)
  participants!: GroupParticipant[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  /**
   * The automation profile this /usr/bin/bash follows (Phase 5).
   *
   * Null means inherit from a broader scope, or fall back to global settings.
   */
  @Column({ type: 'uuid', nullable: true })
  automationProfileId!: string | null;

  /**
   * This group's escalation overrides (§30).
   *
   * The narrowest layer of Global → Profile → Group: which internal group to alert, whether to
   * wake an executive, how many automated replies this group tolerates. Null means "inherit".
   */
  @Column({ type: 'jsonb', nullable: true })
  escalationPolicy!: Record<string, unknown> | null;

  /**
   * When this group was first configured by an onboarding rule (§98).
   *
   * Set once. A group that has been through onboarding is never re-run, so a later group sync
   * cannot quietly undo an operator's manual change and leave them wondering why the setting keeps
   * reverting.
   */
  @Column({ type: 'timestamptz', nullable: true })
  onboardedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  onboardingRuleId!: string | null;
}
