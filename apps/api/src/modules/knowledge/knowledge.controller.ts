import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { InjectRepository } from '@nestjs/typeorm';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { Request, Response } from 'express';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermissions } from '../rbac/permissions.guard';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { KnowledgeArticle } from './entities/knowledge-article.entity';
import { KnowledgeArticleAttachment } from './entities/knowledge-article-attachment.entity';
import { KnowledgeCategory } from './entities/knowledge-category.entity';
import { KnowledgeDocument } from './entities/knowledge-document.entity';
import { KnowledgeProfile } from './entities/knowledge-profile.entity';
import { KnowledgeArticleService } from './knowledge-article.service';
import { KnowledgeCandidateService } from './knowledge-candidate.service';
import { GroupKnowledgeHarvestService } from './group-knowledge-harvest.service';
import { KnowledgeDocumentService } from './knowledge-document.service';
import { KnowledgeIndexService } from './knowledge-index.service';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service';
import {
  CandidateStatus,
  DocumentStatus,
  KnowledgeScopeType,
  KnowledgeStatus,
} from './knowledge-types';

// === DTOs ==========================================================================================

export class CreateArticleDto {
  @IsString() @MinLength(1) @MaxLength(300) title!: string;
  @IsOptional() @IsString() @MaxLength(1000) summary?: string;
  @IsOptional() @IsString() @MaxLength(500_000) body?: string;
  @IsUUID() categoryId!: string;
  @IsOptional() @IsEnum(KnowledgeScopeType) scopeType?: KnowledgeScopeType;
  @IsOptional() @IsUUID() scopeId?: string;
  @IsOptional() @IsUUID() profileId?: string;
  @IsOptional() @IsString() @MaxLength(12) language?: string;
}

export class UpdateArticleDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(300) title?: string;
  @IsOptional() @IsString() @MaxLength(1000) summary?: string;
  @IsOptional() @IsString() @MaxLength(500_000) body?: string;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsEnum(KnowledgeScopeType) scopeType?: KnowledgeScopeType;
  @IsOptional() @IsUUID() scopeId?: string;
  @IsOptional() @IsUUID() profileId?: string;
  @IsOptional() @IsString() @MaxLength(12) language?: string;
}

export class ListArticlesDto {
  @IsOptional() @IsEnum(KnowledgeStatus) status?: KnowledgeStatus;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsEnum(KnowledgeScopeType) scopeType?: KnowledgeScopeType;
  @IsOptional() @IsUUID() scopeId?: string;
  @IsOptional() @IsString() @MaxLength(200) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

export class TransitionDto {
  @IsEnum(KnowledgeStatus) status!: KnowledgeStatus;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class RollbackDto {
  @Type(() => Number) @IsInt() @Min(1) version!: number;
}

export class AddLinkDto {
  @IsString() @MaxLength(2048) url!: string;
  @IsOptional() @IsString() @MaxLength(300) title?: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

export class SearchDto {
  @IsString() @MinLength(1) @MaxLength(500) query!: string;
  @IsOptional() @IsUUID() groupId?: string;
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsUUID() productId?: string;
  @IsOptional() @IsUUID() profileId?: string;
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) categoryIds?: string[];
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
  /**
   * Authoring search. Defaults to production behaviour (published only); a writer looking for their
   * own drafts sets this false, and needs `knowledge.create` to do it.
   */
  @IsOptional() includeUnpublished?: boolean;
}

export class CreateCategoryDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
}

export class CreateProfileDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) categoryIds?: string[];
  @IsOptional() priorityOverride?: Record<string, number>;
}

export class CreateCandidateDto {
  @IsString() @MinLength(3) @MaxLength(500) question!: string;
  @IsOptional() @IsString() @MaxLength(5000) context?: string;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsEnum(KnowledgeScopeType) scopeType?: KnowledgeScopeType;
  @IsOptional() @IsUUID() scopeId?: string;
}

export class ConvertCandidateDto {
  @IsUUID() categoryId!: string;
  @IsOptional() @IsString() @MaxLength(300) title?: string;
  @IsOptional() @IsString() @MaxLength(500_000) body?: string;
}

export class DismissCandidateDto {
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

// === controller ====================================================================================

/**
 * The Knowledge Base API (`PROJECT_SPEC.md` §70–§75, §116).
 *
 * Everything is authenticated and permission-gated. Note what is **absent**: there is no endpoint
 * that sends anything to a customer, and no retrieval endpoint for the Decision Engine — Phase 5
 * runs in this same process and calls `KnowledgeRetrievalService` directly, so exposing retrieval
 * over HTTP would only create a second, weaker path to the same data.
 *
 * Channel agnostic throughout: group and customer ids are opaque UUIDs, and nothing here imports a
 * channel, an adapter or a gateway type.
 */
export class HarvestGroupsDto {
  /** How far back to look. Bounded so one call cannot scan the whole message history. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) sinceDays?: number;
  /** A ceiling per run, so one sweep cannot flood the review queue. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

@ApiTags('knowledge')
@Controller({ path: 'knowledge', version: '1' })
export class KnowledgeController {
  constructor(
    @InjectRepository(KnowledgeArticle) private readonly articleRepo: Repository<KnowledgeArticle>,
    @InjectRepository(KnowledgeDocument) private readonly documentRepo: Repository<KnowledgeDocument>,
    @InjectRepository(KnowledgeCategory) private readonly categoryRepo: Repository<KnowledgeCategory>,
    @InjectRepository(KnowledgeProfile) private readonly profileRepo: Repository<KnowledgeProfile>,
    @InjectRepository(KnowledgeArticleAttachment)
    private readonly attachmentRepo: Repository<KnowledgeArticleAttachment>,
    private readonly articles: KnowledgeArticleService,
    private readonly documents: KnowledgeDocumentService,
    private readonly candidates: KnowledgeCandidateService,
    private readonly harvester: GroupKnowledgeHarvestService,
    private readonly retrieval: KnowledgeRetrievalService,
    private readonly index: KnowledgeIndexService,
    private readonly realtime: RealtimeGateway,
    private readonly audit: AuditService,
  ) {}

  // --- status ------------------------------------------------------------------------------------

  /**
   * Whether semantic search is available.
   *
   * Reports the provider name, model and dimensions — never the credential. The UI uses this to say
   * "semantic search is off" rather than quietly returning keyword-only results as if they were the
   * whole answer.
   */
  @Get('status')
  @RequirePermissions('knowledge.read')
  @ApiOperation({ summary: 'Knowledge base status, including whether semantic search is available' })
  async status() {
    const [articles, published, documents, indexed, failed] = await Promise.all([
      this.articleRepo.count(),
      this.articleRepo.count({ where: { status: KnowledgeStatus.PUBLISHED } }),
      this.documentRepo.count(),
      this.documentRepo.count({ where: { status: DocumentStatus.INDEXED } }),
      this.documentRepo.count({ where: { status: DocumentStatus.FAILED } }),
    ]);

    return {
      articles: { total: articles, published },
      documents: { total: documents, indexed, failed },
      embedding: this.index.embeddingStatus(),
    };
  }

  // --- categories (§71) ---------------------------------------------------------------------------

  @Get('categories')
  @RequirePermissions('knowledge.read')
  @ApiOperation({ summary: 'List knowledge categories' })
  async listCategories() {
    const items = await this.categoryRepo.find({ order: { sortOrder: 'ASC', name: 'ASC' } });
    return { items };
  }

  @Post('categories')
  @RequirePermissions('knowledge.create')
  @ApiOperation({ summary: 'Create a custom category' })
  async createCategory(@Body() dto: CreateCategoryDto, @CurrentUser() user: AuthenticatedUser, @Req() request: Request) {
    const key = dto.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
    if (!key) throw new BadRequestException('That category name cannot be used');
    if (await this.categoryRepo.exist({ where: { key } })) {
      throw new BadRequestException('A category with that name already exists');
    }

    const category = await this.categoryRepo.save(
      this.categoryRepo.create({ key, name: dto.name.trim(), description: dto.description ?? null, isSystem: false }),
    );

    await this.audit.record(
      { action: 'knowledge.category_created', resource: 'knowledge_category', resourceId: category.id, after: { key, name: category.name } },
      this.audit.actorFromRequest(request, user),
    );
    return category;
  }

  // --- profiles (§74) -----------------------------------------------------------------------------

  @Get('profiles')
  @RequirePermissions('knowledge.read')
  @ApiOperation({ summary: 'List knowledge profiles' })
  async listProfiles() {
    return { items: await this.profileRepo.find({ order: { name: 'ASC' } }) };
  }

  @Post('profiles')
  @RequirePermissions('knowledge.approve')
  @ApiOperation({ summary: 'Create a knowledge profile' })
  async createProfile(@Body() dto: CreateProfileDto, @CurrentUser() user: AuthenticatedUser, @Req() request: Request) {
    const profile = await this.profileRepo.save(
      this.profileRepo.create({
        name: dto.name.trim(),
        description: dto.description ?? null,
        categoryIds: dto.categoryIds ?? [],
        priorityOverride: dto.priorityOverride ?? null,
        createdById: user.id,
      }),
    );

    await this.audit.record(
      { action: 'knowledge.profile_created', resource: 'knowledge_profile', resourceId: profile.id, after: { name: profile.name } },
      this.audit.actorFromRequest(request, user),
    );
    return profile;
  }

  // --- articles (§70, §73) ------------------------------------------------------------------------

  @Get('articles')
  @RequirePermissions('knowledge.read')
  @ApiOperation({ summary: 'List articles' })
  async listArticles(@Query() query: ListArticlesDto) {
    const limit = Math.min(query.limit ?? 50, 200);
    const builder = this.articleRepo
      .createQueryBuilder('a')
      .orderBy('a.updatedAt', 'DESC')
      .take(limit)
      .skip(query.offset ?? 0);

    if (query.status) builder.andWhere('a.status = :status', { status: query.status });
    if (query.categoryId) builder.andWhere('a."categoryId" = :categoryId', { categoryId: query.categoryId });
    if (query.scopeType) builder.andWhere('a."scopeType" = :scopeType', { scopeType: query.scopeType });
    if (query.scopeId) builder.andWhere('a."scopeId" = :scopeId', { scopeId: query.scopeId });
    if (query.search) {
      // Parameterised, and `plainto_tsquery` so a title with punctuation cannot act as operators.
      builder.andWhere(
        `(to_tsvector('simple', coalesce(a.title, '') || ' ' || coalesce(a.summary, '')) @@ plainto_tsquery('simple', :q)
          OR a.title ILIKE :like)`,
        { q: query.search, like: `%${query.search}%` },
      );
    }

    const [items, total] = await builder.getManyAndCount();
    return { items: items.map(serializeArticle), total, limit, offset: query.offset ?? 0 };
  }

  @Get('articles/:id')
  @RequirePermissions('knowledge.read')
  @ApiOperation({ summary: 'One article with its links and attachments' })
  async getArticle(@Param('id') id: string) {
    const article = await this.articles.findOne(id);
    const [links, attachments] = await Promise.all([
      this.articles.listLinks(id),
      this.attachmentRepo.find({ where: { articleId: id }, order: { sortOrder: 'ASC' } }),
    ]);
    return { ...serializeArticle(article), body: article.body, links, attachments };
  }

  @Post('articles')
  @RequirePermissions('knowledge.create')
  @ApiOperation({ summary: 'Create an article (always as a draft)' })
  async createArticle(@Body() dto: CreateArticleDto, @CurrentUser() user: AuthenticatedUser, @Req() request: Request) {
    const article = await this.articles.create(dto, user.id);

    await this.audit.record(
      {
        action: 'knowledge.article_created',
        resource: 'knowledge_article',
        resourceId: article.id,
        after: { title: article.title, categoryId: article.categoryId, scopeType: article.scopeType },
      },
      this.audit.actorFromRequest(request, user),
    );
    return serializeArticle(article);
  }

  @Patch('articles/:id')
  @RequirePermissions('knowledge.create')
  @ApiOperation({ summary: 'Edit an article (editing a published article returns it to draft)' })
  async updateArticle(
    @Param('id') id: string,
    @Body() dto: UpdateArticleDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const before = await this.articles.findOne(id);
    const article = await this.articles.update(id, dto, user.id);

    await this.audit.record(
      {
        action: 'knowledge.article_updated',
        resource: 'knowledge_article',
        resourceId: id,
        before: { title: before.title, status: before.status, version: before.currentVersion },
        after: { title: article.title, status: article.status, version: article.currentVersion },
      },
      this.audit.actorFromRequest(request, user),
    );
    return serializeArticle(article);
  }

  /**
   * Moves an article through the lifecycle.
   *
   * Publishing and archiving take `knowledge.approve`; submitting for review or returning to draft
   * take `knowledge.create`. A writer can prepare and withdraw their own work; making it visible to
   * customers is somebody else's decision (§198).
   */
  @Post('articles/:id/status')
  @RequirePermissions('knowledge.create')
  @ApiOperation({ summary: 'Change article status (publish and archive need knowledge.approve)' })
  async transitionArticle(
    @Param('id') id: string,
    @Body() dto: TransitionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const approvalNeeded = dto.status === KnowledgeStatus.PUBLISHED || dto.status === KnowledgeStatus.ARCHIVED;
    if (approvalNeeded && !user.permissions.has('knowledge.approve')) {
      throw new BadRequestException('Publishing and archiving knowledge requires the knowledge.approve permission');
    }

    const before = await this.articles.findOne(id);
    const article = await this.articles.transition(id, dto.status, user.id, dto.note);

    if (article.status === KnowledgeStatus.PUBLISHED) {
      this.realtime.emitKnowledgeEvent('knowledge.article.published', {
        articleId: article.id,
        version: article.currentVersion,
      });
    }

    await this.audit.record(
      {
        action: 'knowledge.article_status_changed',
        resource: 'knowledge_article',
        resourceId: id,
        before: { status: before.status },
        after: { status: article.status, version: article.currentVersion },
      },
      this.audit.actorFromRequest(request, user),
    );
    return serializeArticle(article);
  }

  @Get('articles/:id/versions')
  @RequirePermissions('knowledge.read')
  @ApiOperation({ summary: 'Version history' })
  async listVersions(@Param('id') id: string) {
    return { items: await this.articles.listVersions(id) };
  }

  @Get('articles/:id/diff')
  @RequirePermissions('knowledge.read')
  @ApiOperation({ summary: 'Compare two versions' })
  async diffVersions(@Param('id') id: string, @Query('from') from: string, @Query('to') to: string) {
    const fromVersion = Number(from);
    const toVersion = Number(to);
    if (!Number.isInteger(fromVersion) || !Number.isInteger(toVersion)) {
      throw new BadRequestException('from and to must be version numbers');
    }
    return this.articles.diff(id, fromVersion, toVersion);
  }

  @Post('articles/:id/rollback')
  @RequirePermissions('knowledge.approve')
  @ApiOperation({ summary: 'Restore an earlier version as a new draft version' })
  async rollback(
    @Param('id') id: string,
    @Body() dto: RollbackDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const before = await this.articles.findOne(id);
    const article = await this.articles.rollback(id, dto.version, user.id);

    await this.audit.record(
      {
        action: 'knowledge.article_rolled_back',
        resource: 'knowledge_article',
        resourceId: id,
        before: { version: before.currentVersion, status: before.status },
        after: { version: article.currentVersion, restoredFrom: dto.version, status: article.status },
      },
      this.audit.actorFromRequest(request, user),
    );
    return serializeArticle(article);
  }

  @Delete('articles/:id')
  @RequirePermissions('knowledge.approve')
  @ApiOperation({ summary: 'Delete an article and its chunks' })
  async deleteArticle(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Req() request: Request) {
    const article = await this.articles.findOne(id);
    await this.articles.remove(id);

    await this.audit.record(
      { action: 'knowledge.article_deleted', resource: 'knowledge_article', resourceId: id, before: { title: article.title } },
      this.audit.actorFromRequest(request, user),
    );
    return { deleted: true };
  }

  // --- links and YouTube references (§70) ---------------------------------------------------------

  @Post('articles/:id/links')
  @RequirePermissions('knowledge.create')
  @ApiOperation({ summary: 'Attach a URL or YouTube reference (metadata only — nothing is fetched)' })
  async addLink(@Param('id') id: string, @Body() dto: AddLinkDto, @CurrentUser() user: AuthenticatedUser) {
    return this.articles.addLink(id, dto, user.id);
  }

  @Delete('articles/:id/links/:linkId')
  @RequirePermissions('knowledge.create')
  @ApiOperation({ summary: 'Remove a link' })
  async removeLink(@Param('id') id: string, @Param('linkId') linkId: string) {
    await this.articles.removeLink(id, linkId);
    return { deleted: true };
  }

  // --- documents (§72, §126, §179) ----------------------------------------------------------------

  @Get('documents')
  @RequirePermissions('knowledge.read')
  @ApiOperation({ summary: 'List uploaded documents and their indexing status' })
  async listDocuments(@Query('status') status?: DocumentStatus, @Query('categoryId') categoryId?: string) {
    const items = await this.documentRepo.find({
      where: { ...(status ? { status } : {}), ...(categoryId ? { categoryId } : {}) },
      order: { createdAt: 'DESC' },
      take: 200,
    });
    return { items: items.map(serializeDocument) };
  }

  @Get('documents/:id')
  @RequirePermissions('knowledge.read')
  @ApiOperation({ summary: 'One document' })
  async getDocument(@Param('id') id: string) {
    return serializeDocument(await this.documents.findOne(id));
  }

  /**
   * Uploads a document.
   *
   * Held in memory rather than streamed to a temporary file: the size cap is small enough that the
   * buffer is bounded, and it means a rejected upload never touches the disk at all.
   */
  @Post('documents')
  @RequirePermissions('knowledge.create')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Upload a document for indexing' })
  async uploadDocument(
    @UploadedFile() file: UploadInput | undefined,
    @Body() body: { categoryId?: string; articleId?: string; scopeType?: KnowledgeScopeType; scopeId?: string },
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    if (!file) throw new BadRequestException('No file was uploaded');
    if (!body?.categoryId) throw new BadRequestException('categoryId is required');

    const result = await this.documents.upload(
      file,
      {
        categoryId: body.categoryId,
        articleId: body.articleId ?? null,
        scopeType: body.scopeType,
        scopeId: body.scopeId ?? null,
      },
      user.id,
    );

    await this.audit.record(
      {
        action: 'knowledge.document_uploaded',
        resource: 'knowledge_document',
        resourceId: result.document.id,
        after: {
          filename: result.document.originalFilename,
          mimeType: result.document.mimeType,
          sizeBytes: result.document.sizeBytes,
          duplicate: result.duplicate,
        },
      },
      this.audit.actorFromRequest(request, user),
    );

    return { document: serializeDocument(result.document), jobId: result.jobId, duplicate: result.duplicate };
  }

  /** Streams the stored file. Authenticated and permission-checked — never a direct storage link. */
  @Get('documents/:id/download')
  @RequirePermissions('knowledge.read')
  @ApiOperation({ summary: 'Download a stored document' })
  async downloadDocument(@Param('id') id: string, @Res() response: Response) {
    const { document, stream } = await this.documents.openStream(id);

    response.setHeader('Content-Type', document.mimeType);
    // `attachment` and a quoted, sanitized filename: an inline HTML document would otherwise
    // execute on this origin, which is the whole reason uploads live outside any served path.
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${document.originalFilename.replace(/["\\]/g, '')}"`,
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    stream.pipe(response);
  }

  @Post('documents/:id/reprocess')
  @RequirePermissions('knowledge.create')
  @ApiOperation({ summary: 'Re-run the indexing pipeline for one document' })
  async reprocessDocument(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.documents.reprocess(id, user.id);
  }

  @Post('documents/reindex')
  @RequirePermissions('knowledge.approve')
  @ApiOperation({ summary: 'Queue a re-index across documents' })
  async reindex(
    @Body() body: { categoryId?: string; status?: DocumentStatus },
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const result = await this.documents.reindexAll(body ?? {}, user.id);

    await this.audit.record(
      { action: 'knowledge.reindex', resource: 'knowledge_document', after: { ...result } },
      this.audit.actorFromRequest(request, user),
    );
    return result;
  }

  @Delete('documents/:id')
  @RequirePermissions('knowledge.approve')
  @ApiOperation({ summary: 'Delete a document, its chunks and its stored file' })
  async deleteDocument(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Req() request: Request) {
    const document = await this.documents.findOne(id);
    await this.documents.remove(id);

    await this.audit.record(
      { action: 'knowledge.document_deleted', resource: 'knowledge_document', resourceId: id, before: { filename: document.originalFilename } },
      this.audit.actorFromRequest(request, user),
    );
    return { deleted: true };
  }

  // --- attachments --------------------------------------------------------------------------------

  @Post('articles/:id/attachments/:documentId')
  @RequirePermissions('knowledge.create')
  @ApiOperation({ summary: 'Attach an uploaded document to an article' })
  async attach(
    @Param('id') articleId: string,
    @Param('documentId') documentId: string,
    @Body() body: { caption?: string },
  ) {
    await this.articles.findOne(articleId);
    await this.documents.findOne(documentId);

    const existing = await this.attachmentRepo.findOne({ where: { articleId, documentId } });
    if (existing) return existing;

    return this.attachmentRepo.save(
      this.attachmentRepo.create({ articleId, documentId, caption: body?.caption ?? null }),
    );
  }

  @Delete('articles/:id/attachments/:documentId')
  @RequirePermissions('knowledge.create')
  @ApiOperation({ summary: 'Detach a document from an article' })
  async detach(@Param('id') articleId: string, @Param('documentId') documentId: string) {
    await this.attachmentRepo.delete({ articleId, documentId });
    return { deleted: true };
  }

  // --- search -------------------------------------------------------------------------------------

  /**
   * Operator-facing search.
   *
   * Defaults to production behaviour — published content only. `includeUnpublished` exists so a
   * writer can find their own drafts, and it demands `knowledge.create`; a reader can never widen
   * the result set beyond what a customer-facing retrieval would see.
   */
  @Post('search')
  @RequirePermissions('knowledge.read')
  @ApiOperation({ summary: 'Search the knowledge base' })
  async search(@Body() dto: SearchDto, @CurrentUser() user: AuthenticatedUser) {
    const includeUnpublished = dto.includeUnpublished === true;
    if (includeUnpublished && !user.permissions.has('knowledge.create')) {
      throw new BadRequestException('Searching unpublished knowledge requires the knowledge.create permission');
    }

    return this.retrieval.retrieve({
      query: dto.query,
      groupId: dto.groupId ?? null,
      customerId: dto.customerId ?? null,
      productId: dto.productId ?? null,
      profileId: dto.profileId ?? null,
      categoryIds: dto.categoryIds,
      limit: dto.limit,
      productionOnly: !includeUnpublished,
    });
  }

  // --- candidates (§75) ---------------------------------------------------------------------------

  @Get('candidates')
  @RequirePermissions('knowledge.read')
  @ApiOperation({ summary: 'Knowledge gap queue' })
  async listCandidates(@Query('status') status?: CandidateStatus) {
    return this.candidates.list({ status });
  }

  @Post('candidates')
  @RequirePermissions('knowledge.create')
  @ApiOperation({ summary: 'Record a knowledge gap (manual only in this phase)' })
  async createCandidate(@Body() dto: CreateCandidateDto, @CurrentUser() user: AuthenticatedUser) {
    return this.candidates.create(dto, user.id);
  }

  /**
   * Harvests knowledge candidates from groups that opted in.
   *
   * Creates candidates only — questions a person still has to answer and convert. Groups that have
   * not enabled knowledge contribution are excluded in SQL, so this cannot reach them.
   */
  @Post('candidates/harvest-groups')
  @RequirePermissions('knowledge.approve')
  @ApiOperation({ summary: 'Propose knowledge candidates from opted-in groups' })
  async harvestGroups(
    @Body() dto: HarvestGroupsDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const result = await this.harvester.harvest({ sinceDays: dto.sinceDays, limit: dto.limit });

    await this.audit.record(
      {
        action: 'knowledge.candidates_harvested',
        resource: 'knowledge_candidate',
        after: { ...result, sinceDays: dto.sinceDays ?? 30 },
      },
      this.audit.actorFromRequest(request, user),
    );

    return result;
  }

  @Post('candidates/:id/convert')
  @RequirePermissions('knowledge.create')
  @ApiOperation({ summary: 'Convert a candidate into a draft article' })
  async convertCandidate(
    @Param('id') id: string,
    @Body() dto: ConvertCandidateDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const result = await this.candidates.convert(id, dto, user.id);

    await this.audit.record(
      {
        action: 'knowledge.candidate_converted',
        resource: 'knowledge_candidate',
        resourceId: id,
        after: { articleId: result.article.id, status: result.article.status },
      },
      this.audit.actorFromRequest(request, user),
    );
    return { candidate: result.candidate, article: serializeArticle(result.article) };
  }

  @Post('candidates/:id/dismiss')
  @RequirePermissions('knowledge.create')
  @ApiOperation({ summary: 'Dismiss a candidate' })
  async dismissCandidate(
    @Param('id') id: string,
    @Body() dto: DismissCandidateDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.candidates.dismiss(id, dto?.note ?? null, user.id);
  }
}

/** What multer hands over. Declared locally so the controller needs no multer type import. */
interface UploadInput {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

function serializeArticle(article: KnowledgeArticle) {
  return {
    id: article.id,
    title: article.title,
    slug: article.slug,
    summary: article.summary,
    categoryId: article.categoryId,
    status: article.status,
    currentVersion: article.currentVersion,
    scopeType: article.scopeType,
    scopeId: article.scopeId,
    profileId: article.profileId,
    language: article.language,
    publishedAt: article.publishedAt,
    archivedAt: article.archivedAt,
    createdAt: article.createdAt,
    updatedAt: article.updatedAt,
  };
}

function serializeDocument(document: KnowledgeDocument) {
  return {
    id: document.id,
    filename: document.originalFilename,
    mimeType: document.mimeType,
    sizeBytes: document.sizeBytes,
    categoryId: document.categoryId,
    articleId: document.articleId,
    scopeType: document.scopeType,
    scopeId: document.scopeId,
    status: document.status,
    statusDetail: document.statusDetail,
    pageCount: document.pageCount,
    chunkCount: document.chunkCount,
    indexedAt: document.indexedAt,
    createdAt: document.createdAt,
    // `storageRef` and `checksum` are deliberately absent: the first is an internal handle and the
    // second is a fingerprint of file contents. Neither has any use in a browser.
  };
}
