import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * What a newly discovered group should be configured as (`PROJECT_SPEC.md` §98, §99, §134).
 *
 * Matching is a case-insensitive substring on the group's name, not a regular expression. The
 * spec's own example is `name contains "VIP"`, and the people who write these rules are operators
 * — handing them a regex is handing them a way to accidentally match every group on the account.
 *
 * Every action field is nullable: a rule states only what it sets, so "VIP groups get the Premium
 * profile" does not also silently decide whether AI is on.
 */
@Entity('group_onboarding_rules')
@Index(['isActive', 'priority'])
export class GroupOnboardingRule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 160 })
  name!: string;

  /** Null means "every group on this account" — a deliberate catch-all, ordered last by priority. */
  @Column({ type: 'varchar', length: 190, nullable: true })
  nameContains!: string | null;

  /** Null means the rule applies to every account. */
  @Column({ type: 'uuid', nullable: true })
  channelAccountId!: string | null;

  @Column({ type: 'int', default: 100 })
  priority!: number;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'uuid', nullable: true })
  automationProfileId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  knowledgeProfileId!: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  monitoringState!: string | null;

  @Column({ type: 'boolean', nullable: true })
  automationEnabled!: boolean | null;

  @Column({ type: 'boolean', nullable: true })
  aiEnabled!: boolean | null;

  @Column({ type: 'jsonb', nullable: true })
  escalationPolicy!: Record<string, unknown> | null;

  @Column({ type: 'uuid', nullable: true })
  notifyGroupId!: string | null;

  /** How often this rule has fired, so a rule that matches nothing is visible as such. */
  @Column({ type: 'int', default: 0 })
  matchCount!: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastMatchedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  createdById!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
