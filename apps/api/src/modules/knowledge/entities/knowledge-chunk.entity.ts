import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { KnowledgeScopeType, KnowledgeStatus } from '../knowledge-types';

/**
 * A retrievable passage.
 *
 * `status` and `scopeType`/`scopeId` are denormalised from the parent article or document. They
 * could be joined for, but every retrieval query filters on all three, and the correctness of scope
 * isolation should not depend on remembering to write the join. The indexer is the only writer and
 * always sets them together.
 *
 * **`embedding` is deliberately not mapped here.** TypeORM has no `vector` type; the column is read
 * and written by raw SQL in the indexing and retrieval services, which are the only two places that
 * should be thinking about vector spaces at all.
 */
@Entity('knowledge_chunks')
export class KnowledgeChunk {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  articleId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  documentId!: string | null;

  @Column({ type: 'int' })
  ordinal!: number;

  @Column({ type: 'text' })
  content!: string;

  @Column({ type: 'int', default: 0 })
  tokenCount!: number;

  @Column({ type: 'varchar', length: 300, nullable: true })
  heading!: string | null;

  @Column({ type: 'int', nullable: true })
  pageNumber!: number | null;

  @Column({ type: 'varchar', length: 16, default: KnowledgeScopeType.GLOBAL })
  scopeType!: KnowledgeScopeType;

  @Column({ type: 'uuid', nullable: true })
  scopeId!: string | null;

  @Column({ type: 'varchar', length: 16, default: KnowledgeStatus.DRAFT })
  status!: KnowledgeStatus;

  @Column({ type: 'uuid' })
  categoryId!: string;

  /** Null until embedded. Which model produced it, so a provider change is detectable. */
  @Column({ type: 'varchar', length: 120, nullable: true })
  embeddingModel!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  embeddedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
