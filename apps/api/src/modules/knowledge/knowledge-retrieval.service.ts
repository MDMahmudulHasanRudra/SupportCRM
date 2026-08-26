import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EmbeddingService } from '../../common/ai/embedding-provider';
import { AppLogger } from '../../common/logging/app-logger';
import { MetricsService } from '../../common/metrics/metrics.service';
import { KnowledgeChunk } from './entities/knowledge-chunk.entity';
import { KnowledgeProfile } from './entities/knowledge-profile.entity';
import { KnowledgeScopeType, KnowledgeStatus, SCOPE_PRIORITY } from './knowledge-types';

/**
 * Retrieval — the service Phase 5's Decision Engine will call (`PROJECT_SPEC.md` §14, §74, §198).
 *
 * Four rules define this file, and each one has a test:
 *
 *  1. **Only PUBLISHED content leaves here** on a production call. Not "filtered in application
 *     code afterwards" — a WHERE clause, so a bug elsewhere cannot leak a draft.
 *  2. **Scope isolation is absolute.** A retrieval scoped to group A returns global knowledge and
 *     group A's knowledge. Group B's is not ranked lower; it is not in the result set.
 *  3. **Bounded.** §14 forbids sending the whole knowledge base to an AI. Every call is capped on
 *     both passage count and total characters.
 *  4. **Cited.** Every passage carries its article, document, version and score, so the phase that
 *     uses this can record what it was told and by whom.
 *
 * It is also completely channel agnostic: no adapter, no `ChannelKey`, no WhatsApp. Group and
 * customer ids arrive as opaque UUIDs.
 */

export interface RetrievalQuery {
  query: string;
  /** Scope hints. Absent means "global knowledge only". */
  groupId?: string | null;
  customerId?: string | null;
  productId?: string | null;
  /** Narrows to a profile's categories, and applies its priority overrides. */
  profileId?: string | null;
  categoryIds?: string[];
  limit?: number;
  maxChars?: number;
  /**
   * Production calls see PUBLISHED only. The authoring UI passes `false` so a writer can search
   * their own drafts — and that path is gated on `knowledge.create`, never reachable by the engine.
   */
  productionOnly?: boolean;
}

export interface RetrievedChunk {
  chunkId: string;
  articleId: string | null;
  documentId: string | null;
  title: string | null;
  heading: string | null;
  content: string;
  categoryId: string;
  scopeType: KnowledgeScopeType;
  scopeId: string | null;
  /** Which article version this passage came from, so a citation is reproducible. */
  version: number | null;
  score: number;
  matchedBy: 'keyword' | 'semantic' | 'hybrid';
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  totalCharacters: number;
  /** What actually ran, so a caller can tell a thin result from a degraded one. */
  strategies: { keyword: boolean; semantic: boolean };
  semanticAvailable: boolean;
  truncated: boolean;
}

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;
const DEFAULT_MAX_CHARS = 8_000;

/** How much a full-text match and a vector match each contribute before scope weighting. */
const KEYWORD_WEIGHT = 1.0;
const SEMANTIC_WEIGHT = 1.2;

@Injectable()
export class KnowledgeRetrievalService {
  private readonly logger = new AppLogger(KnowledgeRetrievalService.name);

  constructor(
    @InjectRepository(KnowledgeChunk) private readonly chunks: Repository<KnowledgeChunk>,
    @InjectRepository(KnowledgeProfile) private readonly profiles: Repository<KnowledgeProfile>,
    private readonly embeddings: EmbeddingService,
    private readonly metrics: MetricsService,
  ) {}

  async retrieve(input: RetrievalQuery): Promise<RetrievalResult> {
    const query = input.query.trim();
    const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
    const productionOnly = input.productionOnly !== false;

    if (query.length === 0) {
      return {
        chunks: [],
        totalCharacters: 0,
        strategies: { keyword: false, semantic: false },
        semanticAvailable: this.embeddings.available,
        truncated: false,
      };
    }

    const weights = await this.scopeWeights(input.profileId ?? null);
    const search: SearchInput = {
      query,
      limit,
      productionOnly,
      groupId: input.groupId ?? null,
      customerId: input.customerId ?? null,
      productId: input.productId ?? null,
      categoryIds: await this.categoryFilter(input),
    };

    // Both halves run over the same filtered candidate set, so neither can return a passage the
    // other would have excluded.
    const keyword = await this.keywordSearch(search);
    const semantic = await this.semanticSearch(search);

    const merged = this.merge(keyword, semantic, weights);
    const { chunks, totalCharacters, truncated } = this.applyBudget(merged, limit, maxChars);

    this.metrics.increment('knowledge.retrieval', { semantic: String(semantic !== null) });

    return {
      chunks,
      totalCharacters,
      strategies: { keyword: true, semantic: semantic !== null },
      semanticAvailable: this.embeddings.available,
      truncated,
    };
  }

  // === scope ======================================================================================

  /** A profile narrows the categories in play, and may reorder the scope weights (§74). */
  private async categoryFilter(input: RetrievalQuery): Promise<string[] | null> {
    if (input.categoryIds && input.categoryIds.length > 0) return input.categoryIds;
    if (!input.profileId) return null;

    const profile = await this.profiles.findOne({ where: { id: input.profileId } });
    const ids = profile?.categoryIds ?? [];
    return ids.length > 0 ? ids : null;
  }

  private async scopeWeights(profileId: string | null): Promise<Record<string, number>> {
    if (!profileId) return SCOPE_PRIORITY;
    const profile = await this.profiles.findOne({ where: { id: profileId } });
    return { ...SCOPE_PRIORITY, ...(profile?.priorityOverride ?? {}) };
  }

  // === the two searches ============================================================================

  /**
   * Full-text search over the candidate set.
   *
   * Written as explicit SQL with positional parameters rather than through the query builder: the
   * ranking expression needs the same parameter the filter does, and the builder does not
   * substitute parameters inside a select expression. Positional parameters make what reaches
   * PostgreSQL obvious, which for the one query that enforces scope isolation is worth the verbosity.
   */
  private async keywordSearch(input: SearchInput): Promise<RawHit[]> {
    const params: unknown[] = [];
    const filter = this.buildFilter(input, params);
    // `plainto_tsquery` rather than `to_tsquery`: the input is a customer's question, and
    // `to_tsquery` would let its punctuation act as query operators.
    const queryParam = this.push(params, input.query);

    const sql = `
      SELECT ${SELECT_COLUMNS},
             ts_rank(to_tsvector('simple', c."content"), plainto_tsquery('simple', $${queryParam})) AS rank
        FROM "knowledge_chunks" c
        LEFT JOIN "knowledge_articles" a ON a.id = c."articleId"
       WHERE ${filter}
         AND to_tsvector('simple', c."content") @@ plainto_tsquery('simple', $${queryParam})
       ORDER BY rank DESC
       LIMIT ${this.safeLimit(input.limit * 4)}`;

    return (await this.chunks.query(sql, params)) as RawHit[];
  }

  /**
   * Vector search.
   *
   * Returns null — not an empty list — when semantic search could not run, so the caller can tell
   * "nothing matched" from "this half did not happen".
   */
  private async semanticSearch(input: SearchInput): Promise<RawHit[] | null> {
    if (!this.embeddings.available) return null;

    let vector: number[];
    try {
      const result = await this.embeddings.embed([input.query]);
      vector = result.vectors[0];
      if (!vector) return null;
    } catch (error) {
      // A retrieval must not fail because the embedding provider is down. Keyword results are a
      // worse answer than hybrid ones, and a far better answer than an error.
      this.logger.warn('Semantic retrieval unavailable, falling back to keyword only', {
        error: (error as Error).message,
      });
      this.metrics.increment('knowledge.retrieval_semantic_failed');
      return null;
    }

    const params: unknown[] = [];
    const filter = this.buildFilter(input, params);
    const vectorParam = this.push(params, `[${vector.join(',')}]`);

    // Cosine distance: 0 identical, 2 opposite. Turned into a 0..1 similarity so it composes with
    // the keyword rank in the merge.
    const sql = `
      SELECT ${SELECT_COLUMNS},
             1 - (c."embedding" <=> $${vectorParam}::vector) AS rank
        FROM "knowledge_chunks" c
        LEFT JOIN "knowledge_articles" a ON a.id = c."articleId"
       WHERE ${filter}
         AND c."embedding" IS NOT NULL
       ORDER BY c."embedding" <=> $${vectorParam}::vector
       LIMIT ${this.safeLimit(input.limit * 4)}`;

    return (await this.chunks.query(sql, params)) as RawHit[];
  }

  /**
   * The shared predicate: status, scope and category.
   *
   * One builder for both searches, so neither can return a passage the other would have excluded —
   * the single place where "only published" and "only my scope" are decided.
   */
  private buildFilter(input: SearchInput, params: unknown[]): string {
    const clauses: string[] = [];

    if (input.productionOnly) {
      // §198. A WHERE clause, not a filter applied to results afterwards: the difference matters
      // when someone later adds a code path that forgets the filter.
      clauses.push(`c."status" = $${this.push(params, KnowledgeStatus.PUBLISHED)}`);
    } else {
      clauses.push(`c."status" <> $${this.push(params, KnowledgeStatus.ARCHIVED)}`);
    }

    // The important half is what this EXCLUDES. A call scoped to group A matches global rows and
    // group A's rows; every other scoped row fails here in SQL and never reaches the ranking stage
    // where a weighting mistake could resurrect it.
    const scopeClauses = [`c."scopeType" = 'GLOBAL'`];
    if (input.groupId) {
      scopeClauses.push(`(c."scopeType" = 'GROUP' AND c."scopeId" = $${this.push(params, input.groupId)})`);
    }
    if (input.customerId) {
      scopeClauses.push(`(c."scopeType" = 'CUSTOMER' AND c."scopeId" = $${this.push(params, input.customerId)})`);
    }
    if (input.productId) {
      scopeClauses.push(`(c."scopeType" = 'PRODUCT' AND c."scopeId" = $${this.push(params, input.productId)})`);
    }
    clauses.push(`(${scopeClauses.join(' OR ')})`);

    if (input.categoryIds && input.categoryIds.length > 0) {
      clauses.push(`c."categoryId" = ANY($${this.push(params, input.categoryIds)}::uuid[])`);
    }

    return clauses.join(' AND ');
  }

  private push(params: unknown[], value: unknown): number {
    params.push(value);
    return params.length;
  }

  /** LIMIT is interpolated, so it is forced to a bounded integer rather than trusted. */
  private safeLimit(value: number): number {
    return Math.max(1, Math.min(200, Math.floor(value)));
  }

  // === merge, rank, bound ==========================================================================

  /**
   * Hybrid ranking.
   *
   * A passage found by both searches outranks one found by either alone — agreement between a
   * lexical and a semantic match is the strongest signal available without a reranker. Scope weight
   * multiplies the result, so §74's ordering survives the merge: a group-scoped passage with a
   * decent score beats a global one with a slightly better raw score.
   */
  private merge(
    keyword: RawHit[],
    semantic: RawHit[] | null,
    weights: Record<string, number>,
  ): RetrievedChunk[] {
    const byId = new Map<string, { hit: RawHit; keyword: number; semantic: number }>();

    for (const hit of keyword) {
      byId.set(hit.chunkId, { hit, keyword: Number(hit.rank) || 0, semantic: 0 });
    }
    for (const hit of semantic ?? []) {
      const existing = byId.get(hit.chunkId);
      if (existing) existing.semantic = Number(hit.rank) || 0;
      else byId.set(hit.chunkId, { hit, keyword: 0, semantic: Number(hit.rank) || 0 });
    }

    const scored = [...byId.values()].map(({ hit, keyword: k, semantic: s }) => {
      const scopeWeight = weights[hit.scopeType] ?? SCOPE_PRIORITY[KnowledgeScopeType.GLOBAL];
      const base = k * KEYWORD_WEIGHT + s * SEMANTIC_WEIGHT;
      const agreement = k > 0 && s > 0 ? 1.25 : 1;

      return {
        chunkId: hit.chunkId,
        articleId: hit.articleId,
        documentId: hit.documentId,
        title: hit.title,
        heading: hit.heading,
        content: hit.content,
        categoryId: hit.categoryId,
        scopeType: hit.scopeType,
        scopeId: hit.scopeId,
        version: hit.version === null ? null : Number(hit.version),
        score: base * agreement * scopeWeight,
        matchedBy: (k > 0 && s > 0 ? 'hybrid' : k > 0 ? 'keyword' : 'semantic') as RetrievedChunk['matchedBy'],
      };
    });

    return scored.sort((a, b) => b.score - a.score);
  }

  /**
   * §14 in code: never send the whole knowledge base.
   *
   * Two independent caps. The count keeps a prompt readable; the character budget is what actually
   * protects a context window, because eight long passages are far more text than eight short ones.
   */
  private applyBudget(
    ranked: RetrievedChunk[],
    limit: number,
    maxChars: number,
  ): { chunks: RetrievedChunk[]; totalCharacters: number; truncated: boolean } {
    const chunks: RetrievedChunk[] = [];
    let totalCharacters = 0;

    for (const chunk of ranked) {
      if (chunks.length >= limit) break;
      if (totalCharacters + chunk.content.length > maxChars) {
        // Skip rather than stop: a shorter, lower-ranked passage may still fit, and half a budget
        // left unused helps nobody.
        continue;
      }
      chunks.push(chunk);
      totalCharacters += chunk.content.length;
    }

    return { chunks, totalCharacters, truncated: chunks.length < ranked.length };
  }
}

/** Columns both searches return, so the merge sees one shape. */
const SELECT_COLUMNS = [
  'c.id AS "chunkId"',
  'c."articleId" AS "articleId"',
  'c."documentId" AS "documentId"',
  'c."content" AS content',
  'c."heading" AS heading',
  'c."categoryId" AS "categoryId"',
  'c."scopeType" AS "scopeType"',
  'c."scopeId" AS "scopeId"',
  'a."title" AS title',
  'a."currentVersion" AS version',
].join(', ');

/** The normalised input both searches take. */
interface SearchInput {
  query: string;
  limit: number;
  productionOnly: boolean;
  groupId: string | null;
  customerId: string | null;
  productId: string | null;
  categoryIds: string[] | null;
}

interface RawHit {
  chunkId: string;
  articleId: string | null;
  documentId: string | null;
  title: string | null;
  heading: string | null;
  content: string;
  categoryId: string;
  scopeType: KnowledgeScopeType;
  scopeId: string | null;
  version: number | string | null;
  rank: number | string;
}
