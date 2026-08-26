import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * What is being limited (`PROJECT_SPEC.md` §57).
 *
 * Seven scopes because they fail differently: a session limit protects the WhatsApp account, a
 * destination limit protects one person from being messaged repeatedly, and an API limit protects
 * the system from a caller. One number for all of them would be wrong for six.
 */
export enum RateLimitScope {
  SESSION = 'SESSION',
  GROUP = 'GROUP',
  DESTINATION = 'DESTINATION',
  BROADCAST = 'BROADCAST',
  AUTOMATION = 'AUTOMATION',
  AI = 'AI',
  API = 'API',
}

/**
 * A configurable limit (§57, §175).
 *
 * `scopeId` null means "the default for this scope"; a row with one narrows the limit to a single
 * session, group or destination — which is how one noisy group gets throttled without slowing the
 * whole account down.
 *
 * These exist for account safety, not for evasion. Raising one is an operator accepting a risk to
 * their own WhatsApp account, and the note field is there to record why.
 */
@Entity('rate_limit_policies')
export class RateLimitPolicy {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 24 })
  scope!: RateLimitScope;

  @Column({ type: 'uuid', nullable: true })
  scopeId!: string | null;

  @Column({ type: 'int' })
  limit!: number;

  @Column({ type: 'int' })
  windowSeconds!: number;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'varchar', length: 500, nullable: true })
  note!: string | null;

  @Column({ type: 'uuid', nullable: true })
  updatedById!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
