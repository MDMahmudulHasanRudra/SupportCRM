import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  EmbeddingProviderError,
  EmbeddingService,
  EmbeddingUnavailableError,
} from '../../common/ai/embedding-provider';
import { AppLogger } from '../../common/logging/app-logger';
import { MetricsService } from '../../common/metrics/metrics.service';
import { StorageService } from '../../common/storage/storage.service';
import { KnowledgeArticle } from './entities/knowledge-article.entity';
import { KnowledgeChunk } from './entities/knowledge-chunk.entity';
import { KnowledgeDocument } from './entities/knowledge-document.entity';
import { DocumentStatus, KnowledgeScopeType, KnowledgeStatus } from './knowledge-types';
import { ChunkerService } from './pipeline/chunker.service';
import { DocumentParserService, DocumentParseError, UnsupportedDocumentError } from './pipeline/parser.service';

/**
 * The indexing half of the pipeline (`PROJECT_SPEC.md` §72, steps 4–7).
 *
 * chunk → embed → index, for both articles and uploaded documents.
 *
 * **On embeddings being unavailable.** When no provider is configured, or a provider fails
 * permanently, indexing still completes: the text is chunked and written, so full-text retrieval
 * works, and the document lands in `INDEXED_WITHOUT_VECTORS` with a reason an operator can read.
 * What it never does is invent a vector. A hash-derived embedding would index and query without
 * error and return nonsense, which is worse than an honest "semantic search is off".
 */

export interface IndexOutcome {
  chunks: number;
  embedded: number;
  status: DocumentStatus;
  detail: string | null;
}

@Injectable()
export class KnowledgeIndexService {
  private readonly logger = new AppLogger(KnowledgeIndexService.name);
  private vectorIndexEnsured = false;

  constructor(
    @InjectRepository(KnowledgeArticle) private readonly articles: Repository<KnowledgeArticle>,
    @InjectRepository(KnowledgeDocument) private readonly documents: Repository<KnowledgeDocument>,
    @InjectRepository(KnowledgeChunk) private readonly chunks: Repository<KnowledgeChunk>,
    private readonly dataSource: DataSource,
    private readonly parser: DocumentParserService,
    private readonly chunker: ChunkerService,
    private readonly embeddings: EmbeddingService,
    private readonly storage: StorageService,
    private readonly metrics: MetricsService,
  ) {}

  // === articles ===================================================================================

  /**
   * Re-chunks one article.
   *
   * Called on every content change and every status change. Cheap enough to do synchronously — an
   * article is a page of text, not a 40-page PDF — and doing it inline means an operator who
   * publishes something can search for it immediately rather than eventually.
   */
  async indexArticle(articleId: string): Promise<IndexOutcome> {
    const article = await this.articles.findOne({ where: { id: articleId } });
    if (!article) return { chunks: 0, embedded: 0, status: DocumentStatus.FAILED, detail: 'Article not found' };

    const source = [article.title, article.summary ?? '', article.body].filter(Boolean).join('\n\n');
    const pieces = this.chunker.chunk(source);

    await this.replaceChunks({
      parent: { articleId: article.id },
      rows: pieces.map((piece) => ({
        articleId: article.id,
        documentId: null,
        ordinal: piece.ordinal,
        content: piece.content,
        tokenCount: piece.tokenCount,
        heading: piece.heading,
        pageNumber: null,
        scopeType: article.scopeType,
        scopeId: article.scopeId,
        status: article.status,
        categoryId: article.categoryId,
      })),
    });

    const embedded = await this.embedPending(pieces.map((p) => p.content), { articleId: article.id });
    return {
      chunks: pieces.length,
      embedded: embedded.count,
      status: embedded.failed ? DocumentStatus.INDEXED_WITHOUT_VECTORS : DocumentStatus.INDEXED,
      detail: embedded.detail,
    };
  }

  /**
   * Propagates an article's status and scope onto its chunks.
   *
   * Chunks carry their own copy so retrieval can filter without a join, which means publishing an
   * article has to reach them. A plain UPDATE rather than a re-chunk: the text has not changed.
   */
  async syncArticleChunks(article: KnowledgeArticle): Promise<void> {
    await this.chunks.update(
      { articleId: article.id },
      { status: article.status, scopeType: article.scopeType, scopeId: article.scopeId },
    );
  }

  // === documents ==================================================================================

  /**
   * The full pipeline for one uploaded document. Runs on the worker, one Job Center item per call.
   *
   * Every exit path leaves the document in a terminal state with a reason. A document stuck in
   * PROCESSING because a step threw somewhere unexpected is the failure mode this is written to
   * avoid — the operator would see a spinner forever and never learn why.
   */
  async indexDocument(documentId: string): Promise<IndexOutcome> {
    const document = await this.documents.findOne({ where: { id: documentId } });
    if (!document) throw new Error(`Knowledge document ${documentId} not found`);

    await this.documents.update(document.id, {
      status: DocumentStatus.PROCESSING,
      statusDetail: null,
    });

    // Images and anything else without extractable text are stored and downloadable, but produce
    // no chunks. Phase 4 does no OCR, so pretending otherwise would be a lie in the UI.
    if (!this.parser.isIndexable(document.mimeType)) {
      return this.finish(document.id, {
        chunks: 0,
        embedded: 0,
        status: DocumentStatus.INDEXED,
        detail: 'Stored as an attachment. This file type is not searchable.',
      });
    }

    let text: string;
    let pageCount: number | null;

    try {
      const bytes = await this.readDocument(document);
      const parsed = await this.parser.parse(bytes, document.mimeType);
      text = parsed.text;
      pageCount = parsed.pageCount;
    } catch (error) {
      // A corrupt or unreadable file will be just as corrupt on redelivery. Fail it here with a
      // readable reason rather than burning the queue's retry budget on it.
      if (error instanceof DocumentParseError || error instanceof UnsupportedDocumentError) {
        this.metrics.increment('knowledge.document_parse_failed');
        return this.finish(document.id, {
          chunks: 0,
          embedded: 0,
          status: DocumentStatus.FAILED,
          detail: error.message,
        });
      }
      throw error;
    }

    if (text.trim().length === 0) {
      return this.finish(document.id, {
        chunks: 0,
        embedded: 0,
        status: DocumentStatus.FAILED,
        detail: 'No text could be extracted from this file. A scanned image needs OCR, which is not supported.',
      });
    }

    const pieces = this.chunker.chunk(text);

    // A document's chunks inherit the status of the article they belong to; unattached documents
    // are PUBLISHED, because an operator uploading a manual to the knowledge base has published it.
    const status = await this.documentChunkStatus(document);

    await this.replaceChunks({
      parent: { documentId: document.id },
      rows: pieces.map((piece) => ({
        articleId: null,
        documentId: document.id,
        ordinal: piece.ordinal,
        content: piece.content,
        tokenCount: piece.tokenCount,
        heading: piece.heading,
        pageNumber: null,
        scopeType: document.scopeType,
        scopeId: document.scopeId,
        status,
        categoryId: document.categoryId,
      })),
    });

    const embedded = await this.embedPending(pieces.map((p) => p.content), { documentId: document.id });

    await this.documents.update(document.id, {
      pageCount,
      extractedChars: text.length,
    });

    return this.finish(document.id, {
      chunks: pieces.length,
      embedded: embedded.count,
      status: embedded.failed ? DocumentStatus.INDEXED_WITHOUT_VECTORS : DocumentStatus.INDEXED,
      detail: embedded.detail,
    });
  }

  // === internals ==================================================================================

  private async readDocument(document: KnowledgeDocument): Promise<Buffer> {
    const stream = this.storage.read(document.storageRef);
    const parts: Buffer[] = [];
    for await (const part of stream) parts.push(part as Buffer);
    return Buffer.concat(parts);
  }

  /** An attached document follows its article; a standalone upload is published on arrival. */
  private async documentChunkStatus(document: KnowledgeDocument): Promise<KnowledgeStatus> {
    if (!document.articleId) return KnowledgeStatus.PUBLISHED;
    const article = await this.articles.findOne({ where: { id: document.articleId } });
    return article?.status ?? KnowledgeStatus.DRAFT;
  }

  /**
   * Replaces a parent's chunks atomically.
   *
   * Delete-then-insert in one transaction, which is what makes re-indexing idempotent: a retry
   * after a partial failure cannot leave two generations of chunks side by side, and a concurrent
   * search either sees the old set or the new one, never a half-written mixture.
   */
  private async replaceChunks(input: {
    parent: { articleId: string } | { documentId: string };
    rows: Array<Omit<KnowledgeChunk, 'id' | 'createdAt' | 'embeddingModel' | 'embeddedAt'>>;
  }): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(KnowledgeChunk).delete(input.parent);
      if (input.rows.length === 0) return;
      await manager.getRepository(KnowledgeChunk).insert(input.rows as KnowledgeChunk[]);
    });
  }

  /**
   * Embeds a parent's chunks and writes the vectors.
   *
   * Returns `failed: true` when semantic indexing could not happen, along with the reason — the
   * caller turns that into `INDEXED_WITHOUT_VECTORS` rather than a failure, because the text is
   * indexed and full-text search works.
   *
   * A **retryable** provider error is rethrown: the queue should try again rather than record a
   * permanent state from a temporary outage.
   */
  private async embedPending(
    contents: string[],
    parent: { articleId: string } | { documentId: string },
  ): Promise<{ count: number; failed: boolean; detail: string | null }> {
    if (contents.length === 0) return { count: 0, failed: false, detail: null };

    if (!this.embeddings.available) {
      this.metrics.increment('knowledge.embedding_unavailable');
      return {
        count: 0,
        failed: true,
        detail: 'Semantic search is unavailable: no embedding provider is configured. Full-text search still works.',
      };
    }

    let vectors: number[][];
    try {
      const result = await this.embeddings.embed(contents);
      vectors = result.vectors;
    } catch (error) {
      if (error instanceof EmbeddingProviderError && error.retryable) throw error;

      this.metrics.increment('knowledge.embedding_failed');
      const reason =
        error instanceof EmbeddingUnavailableError || error instanceof EmbeddingProviderError
          ? error.message
          : 'the embedding provider rejected the request';
      return {
        count: 0,
        failed: true,
        detail: `Indexed for text search only — semantic indexing failed: ${reason}`,
      };
    }

    await this.ensureVectorIndex();

    const model = this.embeddings.model;
    const rows = await this.chunks.find({
      where: parent,
      order: { ordinal: 'ASC' },
      select: { id: true, ordinal: true },
    });

    for (const row of rows) {
      const vector = vectors[row.ordinal];
      if (!vector) continue;
      // Parameterised, and pgvector parses the literal. The array is numbers this process just
      // produced, but it goes through a bound parameter like everything else.
      await this.chunks.query(
        `UPDATE "knowledge_chunks"
            SET "embedding" = $1::vector, "embeddingModel" = $2, "embeddedAt" = now()
          WHERE "id" = $3`,
        [`[${vector.join(',')}]`, model, row.id],
      );
    }

    this.metrics.increment('knowledge.chunks_embedded', {}, rows.length);
    return { count: rows.length, failed: false, detail: null };
  }

  /**
   * Builds the vector index once there is something to index.
   *
   * IVFFlat clusters the vectors it can see when it is built, so building it on an empty table
   * produces an index that stays bad for the life of the deployment. A sequential scan over a few
   * thousand chunks is fast; a mistrained index is permanently slow and quietly inaccurate.
   */
  private async ensureVectorIndex(): Promise<void> {
    if (this.vectorIndexEnsured) return;

    const [{ count }] = (await this.chunks.query(
      `SELECT count(*)::int AS count FROM "knowledge_chunks" WHERE "embedding" IS NOT NULL`,
    )) as Array<{ count: number }>;

    if (count < 1_000) {
      // Not enough vectors for clustering to mean anything yet. Checked again next time.
      return;
    }

    const lists = Math.max(1, Math.min(1_000, Math.floor(Math.sqrt(count))));
    await this.chunks.query(
      `CREATE INDEX IF NOT EXISTS "IDX_knowledge_chunks_embedding"
         ON "knowledge_chunks" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = ${lists})`,
    );
    this.vectorIndexEnsured = true;
    this.logger.log('Knowledge vector index built', { vectors: count, lists });
  }

  private async finish(documentId: string, outcome: IndexOutcome): Promise<IndexOutcome> {
    await this.documents.update(documentId, {
      status: outcome.status,
      statusDetail: outcome.detail,
      chunkCount: outcome.chunks,
      indexedAt: new Date(),
    });
    return outcome;
  }

  /** Used by the scope-isolation tests and by article deletion. */
  async deleteChunksFor(parent: { articleId: string } | { documentId: string }): Promise<void> {
    await this.chunks.delete(parent);
  }

  /** Reports whether semantic search is available, for the UI and the API. */
  embeddingStatus(): ReturnType<EmbeddingService['describe']> {
    return this.embeddings.describe();
  }

  /** Scope helper shared with the retrieval service. */
  static isScoped(scopeType: KnowledgeScopeType): boolean {
    return scopeType !== KnowledgeScopeType.GLOBAL;
  }
}
