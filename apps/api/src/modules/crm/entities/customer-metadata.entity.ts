import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * An internal note on a customer (Phase 3 brief §9).
 *
 * **Internal CRM data.** The brief is explicit that notes and tags must never automatically reach a
 * customer or an AI context unless an approved context policy includes them. Phase 3 therefore
 * gives notes no path into any outbound or AI surface at all: `MessageService` cannot read this
 * table, and there is no serializer that folds a note into a message. When Phase 6 builds AI
 * context assembly, including notes must be an explicit, reviewed decision there — the absence of a
 * link today is what forces that decision to be made consciously.
 *
 * Notes are append-only in spirit: editing is allowed by the author, but they are never deleted, so
 * the record of what was known when survives.
 */
@Entity('customer_notes')
@Index(['customerId', 'createdAt'])
export class CustomerNote {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  customerId!: string;

  @Column({ type: 'text' })
  body!: string;

  @Column({ type: 'uuid', nullable: true })
  authorId!: string | null;

  /** Denormalised so the note stays attributable if the user is later removed. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  authorUsername!: string | null;

  /**
   * `true` marks a note that should be surfaced prominently in the inbox — an allergy to a
   * particular workaround, a billing dispute in progress. Display only; it grants no AI access.
   */
  @Column({ type: 'boolean', default: false })
  isPinned!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

/**
 * A tag (`PROJECT_SPEC.md` §63).
 *
 * A real table rather than a free string on each entity, so renaming a tag is one write and a
 * typo cannot silently create a near-duplicate that splits a filter's results.
 */
@Entity('tags')
export class Tag {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Lowercased, unique. The display form lives in `label`. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  key!: string;

  @Column({ type: 'varchar', length: 80 })
  label!: string;

  /** Hex colour for the UI chip. Validated on write; never interpolated into markup unescaped. */
  @Column({ type: 'varchar', length: 16, nullable: true })
  color!: string | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

/** What a tag can be attached to. `PROJECT_SPEC.md` §63 names customer, group and conversation. */
export enum TaggableEntity {
  CUSTOMER = 'customer',
  CONVERSATION = 'conversation',
  GROUP = 'group',
}

/**
 * A polymorphic tag attachment.
 *
 * No foreign key to the target: the column points at three different tables, and a polymorphic FK
 * is not expressible. The trade-off is deliberate — the alternative is three near-identical join
 * tables, and `PROJECT_SPEC.md` §111 names a single `entity_tags`. Orphans are prevented by
 * deleting attachments alongside their target in the owning service.
 */
@Entity('entity_tags')
@Index(['entityType', 'entityId'])
export class EntityTag {
  @PrimaryColumn({ type: 'uuid' })
  tagId!: string;

  @PrimaryColumn({ type: 'varchar', length: 24 })
  entityType!: TaggableEntity;

  @PrimaryColumn({ type: 'uuid' })
  entityId!: string;

  @Column({ type: 'uuid', nullable: true })
  taggedById!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

/**
 * A support team — an assignment target that is a queue rather than a person (brief §8).
 *
 * Minimal by design: Phase 3 needs somewhere to assign a conversation when no individual owns it
 * yet. Membership, rotas, availability and escalation ladders belong to Phase 7.
 */
@Entity('support_teams')
export class SupportTeam {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  key!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  /** Deactivated rather than deleted, so historical assignments stay resolvable. */
  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
