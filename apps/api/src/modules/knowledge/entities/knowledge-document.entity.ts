import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { DocumentStatus, KnowledgeScopeType } from '../knowledge-types';

/**
 * An uploaded file (`PROJECT_SPEC.md` §72, §126, §179).
 *
 * `originalFilename` is what the uploader called it and is **metadata only** — it never forms part
 * of a path. `storageRef` is an opaque handle from `StorageService`; resolving it to a location is
 * that service's business and nobody else's.
 */
@Entity('knowledge_documents')
export class KnowledgeDocument {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  originalFilename!: string;

  @Column({ type: 'varchar', length: 128 })
  mimeType!: string;

  @Column({ type: 'bigint', transformer: { to: (v: number) => v, from: (v: string) => Number(v) } })
  sizeBytes!: number;

  /** SHA-256. Unique per category, which makes re-uploading the same file idempotent. */
  @Column({ type: 'char', length: 64 })
  checksum!: string;

  @Column({ type: 'varchar', length: 512 })
  storageRef!: string;

  @Column({ type: 'uuid' })
  categoryId!: string;

  @Column({ type: 'uuid', nullable: true })
  articleId!: string | null;

  @Column({ type: 'varchar', length: 16, default: KnowledgeScopeType.GLOBAL })
  scopeType!: KnowledgeScopeType;

  @Column({ type: 'uuid', nullable: true })
  scopeId!: string | null;

  @Index()
  @Column({ type: 'varchar', length: 32, default: DocumentStatus.PENDING })
  status!: DocumentStatus;

  @Column({ type: 'int', nullable: true })
  pageCount!: number | null;

  @Column({ type: 'int', default: 0 })
  chunkCount!: number;

  @Column({ type: 'int', default: 0 })
  extractedChars!: number;

  /** Why it failed, or why it indexed without vectors. Written for an operator to read. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  statusDetail!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  indexedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  uploadedById!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
