import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Binds an uploaded document to an article as an attachment — an image, a diagram, a manual.
 *
 * Metadata and storage only: Phase 4 runs no OCR and does no image understanding. An attached image
 * is a file an operator can download, not a source of retrievable text.
 */
@Entity('knowledge_article_attachments')
export class KnowledgeArticleAttachment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  articleId!: string;

  @Column({ type: 'uuid' })
  documentId!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  caption!: string | null;

  @Column({ type: 'int', default: 0 })
  sortOrder!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
