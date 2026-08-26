import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AppLogger } from '../../common/logging/app-logger';
import { MetricsService } from '../../common/metrics/metrics.service';
import { KnowledgeArticle } from './entities/knowledge-article.entity';
import { KnowledgeArticleLink } from './entities/knowledge-article-link.entity';
import { KnowledgeArticleVersion } from './entities/knowledge-article-version.entity';
import { KnowledgeCategory } from './entities/knowledge-category.entity';
import { KnowledgeIndexService } from './knowledge-index.service';
import { KnowledgeLinkKind, KnowledgeScopeType, KnowledgeStatus } from './knowledge-types';

/**
 * Authoring, approval and history (`PROJECT_SPEC.md` §70, §73, §198).
 *
 * The lifecycle is the point of this service. DRAFT → REVIEW → PUBLISHED → ARCHIVED, with every
 * transition recorded as an immutable version, because "only Published knowledge is available to
 * production AI" only means something if what was published is knowable afterwards.
 */

export interface ArticleInput {
  title: string;
  summary?: string | null;
  body?: string;
  categoryId: string;
  scopeType?: KnowledgeScopeType;
  scopeId?: string | null;
  profileId?: string | null;
  language?: string;
}

/**
 * Which transitions are legal.
 *
 * A table rather than scattered `if` statements: the set of legal transitions is a rule of the
 * specification, and it should be readable in one place. Note that ARCHIVED can go back to DRAFT —
 * archiving is how you retire an article, not how you delete it, and retired knowledge often comes
 * back with edits.
 */
const ALLOWED_TRANSITIONS: Record<KnowledgeStatus, KnowledgeStatus[]> = {
  [KnowledgeStatus.DRAFT]: [KnowledgeStatus.REVIEW, KnowledgeStatus.PUBLISHED, KnowledgeStatus.ARCHIVED],
  [KnowledgeStatus.REVIEW]: [KnowledgeStatus.DRAFT, KnowledgeStatus.PUBLISHED, KnowledgeStatus.ARCHIVED],
  [KnowledgeStatus.PUBLISHED]: [KnowledgeStatus.DRAFT, KnowledgeStatus.ARCHIVED],
  [KnowledgeStatus.ARCHIVED]: [KnowledgeStatus.DRAFT],
};

@Injectable()
export class KnowledgeArticleService {
  private readonly logger = new AppLogger(KnowledgeArticleService.name);

  constructor(
    @InjectRepository(KnowledgeArticle) private readonly articles: Repository<KnowledgeArticle>,
    @InjectRepository(KnowledgeArticleVersion) private readonly versions: Repository<KnowledgeArticleVersion>,
    @InjectRepository(KnowledgeArticleLink) private readonly links: Repository<KnowledgeArticleLink>,
    @InjectRepository(KnowledgeCategory) private readonly categories: Repository<KnowledgeCategory>,
    private readonly index: KnowledgeIndexService,
    private readonly dataSource: DataSource,
    private readonly metrics: MetricsService,
  ) {}

  async findOne(id: string): Promise<KnowledgeArticle> {
    const article = await this.articles.findOne({ where: { id } });
    if (!article) throw new NotFoundException(`Knowledge article ${id} not found`);
    return article;
  }

  async create(input: ArticleInput, userId: string | null): Promise<KnowledgeArticle> {
    await this.assertCategory(input.categoryId);
    this.assertScope(input.scopeType ?? KnowledgeScopeType.GLOBAL, input.scopeId ?? null);

    const article = await this.articles.save(
      this.articles.create({
        title: input.title.trim(),
        slug: await this.uniqueSlug(input.title),
        summary: input.summary?.trim() || null,
        body: input.body ?? '',
        categoryId: input.categoryId,
        status: KnowledgeStatus.DRAFT,
        currentVersion: 1,
        scopeType: input.scopeType ?? KnowledgeScopeType.GLOBAL,
        scopeId: input.scopeId ?? null,
        profileId: input.profileId ?? null,
        language: input.language ?? 'en',
        createdById: userId,
        updatedById: userId,
      }),
    );

    await this.snapshot(article, 'Created', userId);
    await this.index.indexArticle(article.id);
    this.metrics.increment('knowledge.article_created');

    return article;
  }

  /**
   * Edits an article and snapshots the result.
   *
   * Editing a PUBLISHED article moves it back to DRAFT. That is deliberate and is the whole point
   * of §198: what is live stays live until somebody approves the change, rather than edits going
   * straight to customers because the article happened to be published already.
   */
  async update(id: string, input: Partial<ArticleInput>, userId: string | null): Promise<KnowledgeArticle> {
    const article = await this.findOne(id);

    if (input.categoryId) await this.assertCategory(input.categoryId);
    const scopeType = input.scopeType ?? article.scopeType;
    const scopeId = input.scopeId === undefined ? article.scopeId : input.scopeId;
    this.assertScope(scopeType, scopeId);

    const contentChanged =
      (input.title !== undefined && input.title !== article.title) ||
      (input.body !== undefined && input.body !== article.body) ||
      (input.summary !== undefined && (input.summary ?? null) !== article.summary);

    const demoted = contentChanged && article.status === KnowledgeStatus.PUBLISHED;

    await this.articles.update(article.id, {
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.summary !== undefined ? { summary: input.summary?.trim() || null } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
      ...(input.profileId !== undefined ? { profileId: input.profileId } : {}),
      ...(input.language !== undefined ? { language: input.language } : {}),
      scopeType,
      scopeId,
      ...(demoted ? { status: KnowledgeStatus.DRAFT, publishedAt: null } : {}),
      ...(contentChanged ? { currentVersion: article.currentVersion + 1 } : {}),
      updatedById: userId,
    });

    const updated = await this.findOne(article.id);
    if (contentChanged) {
      await this.snapshot(updated, demoted ? 'Edited — returned to draft' : 'Edited', userId);
    }
    // Re-chunk unconditionally: scope may have changed even when the text did not, and chunks carry
    // their own copy of the scope.
    await this.index.indexArticle(updated.id);

    return updated;
  }

  /**
   * Moves an article through the lifecycle.
   *
   * Publishing is the transition that matters: it is the moment content becomes eligible for
   * production retrieval, so it takes a permission the other transitions do not, and it propagates
   * to the chunks in the same call rather than waiting for a background pass.
   */
  async transition(
    id: string,
    to: KnowledgeStatus,
    userId: string | null,
    note?: string,
  ): Promise<KnowledgeArticle> {
    const article = await this.findOne(id);

    if (article.status === to) return article;
    if (!ALLOWED_TRANSITIONS[article.status].includes(to)) {
      throw new ConflictException(`An article cannot go from ${article.status} to ${to}`);
    }

    await this.articles.update(article.id, {
      status: to,
      ...(to === KnowledgeStatus.PUBLISHED
        ? { publishedAt: new Date(), publishedById: userId, archivedAt: null }
        : {}),
      ...(to === KnowledgeStatus.ARCHIVED ? { archivedAt: new Date() } : {}),
      updatedById: userId,
    });

    const updated = await this.findOne(article.id);
    await this.snapshot(updated, note ?? `Status changed to ${to}`, userId);
    // Chunks carry the status, so retrieval sees this immediately.
    await this.index.syncArticleChunks(updated);

    this.metrics.increment('knowledge.article_transition', { to });
    this.logger.log('Knowledge article status changed', {
      articleId: updated.id,
      from: article.status,
      to,
    });

    return updated;
  }

  /**
   * Restores an earlier version's content.
   *
   * Writes a **new** version rather than deleting the ones after it. History is evidence of what
   * was approved and when; a rollback that erased it would make the audit trail a lie.
   *
   * The restored article is a DRAFT even if it was published before — re-publishing old content is
   * a decision someone should make deliberately.
   */
  async rollback(id: string, toVersion: number, userId: string | null): Promise<KnowledgeArticle> {
    const article = await this.findOne(id);
    const target = await this.versions.findOne({ where: { articleId: id, version: toVersion } });
    if (!target) throw new NotFoundException(`Version ${toVersion} of this article does not exist`);

    await this.articles.update(article.id, {
      title: target.title,
      summary: target.summary,
      body: target.body,
      status: KnowledgeStatus.DRAFT,
      publishedAt: null,
      currentVersion: article.currentVersion + 1,
      updatedById: userId,
    });

    const updated = await this.findOne(article.id);
    await this.snapshot(updated, `Rolled back to v${toVersion}`, userId);
    await this.index.indexArticle(updated.id);

    this.metrics.increment('knowledge.article_rollback');
    return updated;
  }

  async listVersions(id: string): Promise<KnowledgeArticleVersion[]> {
    await this.findOne(id);
    return this.versions.find({ where: { articleId: id }, order: { version: 'DESC' } });
  }

  async getVersion(id: string, version: number): Promise<KnowledgeArticleVersion> {
    const row = await this.versions.findOne({ where: { articleId: id, version } });
    if (!row) throw new NotFoundException(`Version ${version} of this article does not exist`);
    return row;
  }

  /**
   * A line-level diff between two versions.
   *
   * Computed here rather than in the browser so the comparison is the same everywhere it is shown,
   * and so a reviewer approving a change is looking at the server's view of it.
   */
  async diff(id: string, from: number, to: number) {
    const [a, b] = await Promise.all([this.getVersion(id, from), this.getVersion(id, to)]);
    return {
      from: { version: a.version, createdAt: a.createdAt },
      to: { version: b.version, createdAt: b.createdAt },
      title: a.title === b.title ? null : { from: a.title, to: b.title },
      summary: a.summary === b.summary ? null : { from: a.summary, to: b.summary },
      body: diffLines(a.body, b.body),
    };
  }

  async remove(id: string): Promise<void> {
    const article = await this.findOne(id);
    // Chunks cascade with the article, but deleting them explicitly keeps the retrieval index
    // correct even if the cascade is ever changed.
    await this.index.deleteChunksFor({ articleId: article.id });
    await this.articles.delete(article.id);
  }

  // === links (§70) ================================================================================

  /**
   * Attaches a URL or a YouTube reference.
   *
   * Metadata only, by decision: nothing here fetches the page, downloads the video or transcribes
   * anything. The video id is parsed from the URL locally so the UI can show a thumbnail link
   * without a single outbound request.
   */
  async addLink(
    articleId: string,
    input: { url: string; title?: string | null; note?: string | null },
    userId: string | null,
  ): Promise<KnowledgeArticleLink> {
    await this.findOne(articleId);

    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      throw new BadRequestException('That does not look like a valid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BadRequestException('Only http and https links can be attached');
    }

    const youTubeId = parseYouTubeId(parsed);

    return this.links.save(
      this.links.create({
        articleId,
        kind: youTubeId ? KnowledgeLinkKind.YOUTUBE : KnowledgeLinkKind.LINK,
        url: parsed.toString(),
        title: input.title?.trim() || null,
        note: input.note?.trim() || null,
        externalRef: youTubeId,
        createdById: userId,
      }),
    );
  }

  async listLinks(articleId: string): Promise<KnowledgeArticleLink[]> {
    return this.links.find({ where: { articleId }, order: { sortOrder: 'ASC', createdAt: 'ASC' } });
  }

  async removeLink(articleId: string, linkId: string): Promise<void> {
    const link = await this.links.findOne({ where: { id: linkId, articleId } });
    if (!link) throw new NotFoundException('Link not found on this article');
    await this.links.delete(link.id);
  }

  // === internals ==================================================================================

  private async snapshot(
    article: KnowledgeArticle,
    changeSummary: string,
    userId: string | null,
  ): Promise<void> {
    // Insert-and-ignore-conflict: two edits racing on the same version number is a lost snapshot,
    // never a failed edit. The article row is the source of truth for the current version.
    await this.dataSource
      .createQueryBuilder()
      .insert()
      .into(KnowledgeArticleVersion)
      .values({
        articleId: article.id,
        version: article.currentVersion,
        title: article.title,
        summary: article.summary,
        body: article.body,
        status: article.status,
        changeSummary: changeSummary.slice(0, 500),
        createdById: userId,
      })
      .orIgnore()
      .execute();
  }

  private async assertCategory(categoryId: string): Promise<void> {
    const exists = await this.categories.exist({ where: { id: categoryId } });
    if (!exists) throw new BadRequestException('That knowledge category does not exist');
  }

  /**
   * Scope integrity.
   *
   * A GLOBAL article with a scope id, or a GROUP article without one, would each break isolation in
   * a way that is hard to see: the first leaks nothing but confuses ranking, the second becomes
   * invisible to every scoped query. The database has the same CHECK; this produces the readable
   * error.
   */
  private assertScope(scopeType: KnowledgeScopeType, scopeId: string | null): void {
    if (scopeType === KnowledgeScopeType.GLOBAL && scopeId) {
      throw new BadRequestException('Global knowledge cannot be tied to a specific group or customer');
    }
    if (scopeType !== KnowledgeScopeType.GLOBAL && !scopeId) {
      throw new BadRequestException(`${scopeType}-scoped knowledge needs the id it applies to`);
    }
  }

  private async uniqueSlug(title: string): Promise<string> {
    const base =
      title
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 280) || 'article';

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      if (!(await this.articles.exist({ where: { slug: candidate } }))) return candidate;
    }
    return `${base}-${Date.now()}`;
  }
}

/** YouTube ids from the URL shapes people actually paste. No network call. */
function parseYouTubeId(url: URL): string | null {
  const host = url.hostname.replace(/^www\./, '');
  if (host === 'youtu.be') return url.pathname.slice(1).split('/')[0] || null;
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    if (url.pathname === '/watch') return url.searchParams.get('v');
    const embed = /^\/(embed|shorts|live)\/([^/?]+)/.exec(url.pathname);
    if (embed) return embed[2];
  }
  return null;
}

/**
 * A line diff, longest-common-subsequence style.
 *
 * Small enough to keep in the repository rather than take a dependency for: articles are prose, and
 * a reviewer needs to see which lines changed, not a character-level edit script.
 */
function diffLines(from: string, to: string): Array<{ type: 'same' | 'added' | 'removed'; text: string }> {
  const a = from.split('\n');
  const b = to.split('\n');

  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: Array<{ type: 'same' | 'added' | 'removed'; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: 'removed', text: a[i] });
      i += 1;
    } else {
      out.push({ type: 'added', text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) out.push({ type: 'removed', text: a[i++] });
  while (j < b.length) out.push({ type: 'added', text: b[j++] });

  return out;
}
