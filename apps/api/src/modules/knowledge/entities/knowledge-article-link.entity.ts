import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { KnowledgeLinkKind } from '../knowledge-types';

/**
 * A URL attached to an article — a documentation link or a YouTube reference (`PROJECT_SPEC.md`
 * §70).
 *
 * **Metadata only.** Phase 4 stores the URL, a title and a note, and does not crawl the page,
 * download the video or transcribe anything. `externalRef` (a YouTube video id) is parsed from the
 * URL locally, with no network call.
 */
@Entity('knowledge_article_links')
export class KnowledgeArticleLink {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  articleId!: string;

  @Column({ type: 'varchar', length: 16, default: KnowledgeLinkKind.LINK })
  kind!: KnowledgeLinkKind;

  @Column({ type: 'varchar', length: 2048 })
  url!: string;

  @Column({ type: 'varchar', length: 300, nullable: true })
  title!: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  note!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  externalRef!: string | null;

  @Column({ type: 'int', default: 0 })
  sortOrder!: number;

  @Column({ type: 'uuid', nullable: true })
  createdById!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
