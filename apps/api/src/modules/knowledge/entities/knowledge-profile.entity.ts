import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * A named bundle of knowledge settings a group or customer can be bound to (`PROJECT_SPEC.md` §42,
 * §44, §74).
 *
 * Phase 4 stores and manages them; Phase 5's Decision Engine is what will read them when choosing
 * what a given group's retrieval should draw on.
 */
@Entity('knowledge_profiles')
export class KnowledgeProfile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  /** Categories this profile draws on. Empty means every category. */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  categoryIds!: string[];

  /** Overrides `SCOPE_PRIORITY` for anything bound to this profile. Null means the default order. */
  @Column({ type: 'jsonb', nullable: true })
  priorityOverride!: Record<string, number> | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'uuid', nullable: true })
  createdById!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
