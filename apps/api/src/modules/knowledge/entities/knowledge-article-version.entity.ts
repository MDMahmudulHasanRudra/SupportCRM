import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { KnowledgeStatus } from '../knowledge-types';

/**
 * One immutable snapshot of an article (`PROJECT_SPEC.md` §73).
 *
 * Never updated, never deleted. Rollback writes a *new* version whose content matches an old one,
 * so the record of what an approver actually approved survives every later edit.
 */
@Entity('knowledge_article_versions')
export class KnowledgeArticleVersion {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  articleId!: string;

  @Column({ type: 'int' })
  version!: number;

  @Column({ type: 'varchar', length: 300 })
  title!: string;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  summary!: string | null;

  @Column({ type: 'text' })
  body!: string;

  @Column({ type: 'varchar', length: 16 })
  status!: KnowledgeStatus;

  @Column({ type: 'varchar', length: 500, nullable: true })
  changeSummary!: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdById!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
