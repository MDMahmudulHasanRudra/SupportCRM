import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { KnowledgeScopeType, KnowledgeStatus } from '../knowledge-types';

/**
 * An article — the authored unit of knowledge (`PROJECT_SPEC.md` §70, §73).
 *
 * The body lives here in full and is *also* chunked into `knowledge_chunks`, which is what
 * retrieval searches. Duplication on purpose: editing works on a whole document, retrieval works on
 * passages, and making one row serve both would compromise both.
 */
@Entity('knowledge_articles')
export class KnowledgeArticle {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 300 })
  title!: string;

  @Column({ type: 'varchar', length: 320, unique: true })
  slug!: string;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  summary!: string | null;

  @Column({ type: 'text', default: '' })
  body!: string;

  @Column({ type: 'uuid' })
  categoryId!: string;

  @Index()
  @Column({ type: 'varchar', length: 16, default: KnowledgeStatus.DRAFT })
  status!: KnowledgeStatus;

  @Column({ type: 'int', default: 1 })
  currentVersion!: number;

  /** §74. GLOBAL articles have a null `scopeId`; a CHECK constraint enforces the pairing. */
  @Column({ type: 'varchar', length: 16, default: KnowledgeScopeType.GLOBAL })
  scopeType!: KnowledgeScopeType;

  /** A group id, customer id or product id, depending on `scopeType`. Opaque here. */
  @Column({ type: 'uuid', nullable: true })
  scopeId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  profileId!: string | null;

  @Column({ type: 'varchar', length: 12, default: 'en' })
  language!: string;

  @Column({ type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  archivedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  createdById!: string | null;

  @Column({ type: 'uuid', nullable: true })
  updatedById!: string | null;

  @Column({ type: 'uuid', nullable: true })
  publishedById!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
