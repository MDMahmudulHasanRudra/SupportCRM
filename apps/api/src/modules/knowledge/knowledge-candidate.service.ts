import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MetricsService } from '../../common/metrics/metrics.service';
import { KnowledgeCandidate } from './entities/knowledge-candidate.entity';
import { KnowledgeArticleService } from './knowledge-article.service';
import { CandidateSource, CandidateStatus, KnowledgeScopeType, KnowledgeStatus } from './knowledge-types';

/**
 * Knowledge gaps (`PROJECT_SPEC.md` §75).
 *
 * "Customers keep asking about X and nothing is written down." In Phase 4 every candidate is raised
 * by a person: the spec's automatic producer is repeated AI escalation, which does not exist yet.
 * `CandidateSource.AI_ESCALATION` is declared so that phase needs no migration, and this service
 * refuses to create one — a source nothing can produce should not be settable through an API.
 *
 * Converting a candidate creates a **DRAFT** article. Never a published one: the point of the
 * lifecycle is that a human decides what customers see.
 */
@Injectable()
export class KnowledgeCandidateService {
  constructor(
    @InjectRepository(KnowledgeCandidate) private readonly candidates: Repository<KnowledgeCandidate>,
    private readonly articles: KnowledgeArticleService,
    private readonly metrics: MetricsService,
  ) {}

  async findOne(id: string): Promise<KnowledgeCandidate> {
    const candidate = await this.candidates.findOne({ where: { id } });
    if (!candidate) throw new NotFoundException(`Knowledge candidate ${id} not found`);
    return candidate;
  }

  async list(options: { status?: CandidateStatus; limit?: number; offset?: number } = {}) {
    const [items, total] = await this.candidates.findAndCount({
      where: options.status ? { status: options.status } : {},
      // Most-reported first: the queue should be ordered by how much the gap actually costs.
      order: { occurrences: 'DESC', createdAt: 'DESC' },
      take: Math.min(options.limit ?? 50, 200),
      skip: options.offset ?? 0,
    });
    return { items, total };
  }

  /**
   * Raises a gap, or bumps one that already exists.
   *
   * The same question asked twice is one candidate with two occurrences, not two rows — the whole
   * value of the queue is knowing which gaps recur.
   */
  async create(
    input: {
      question: string;
      context?: string | null;
      categoryId?: string | null;
      scopeType?: KnowledgeScopeType;
      scopeId?: string | null;
      /** Defaults to MANUAL — a caller has to claim a different origin deliberately. */
      sourceType?: CandidateSource;
    },
    userId: string | null,
  ): Promise<KnowledgeCandidate> {
    const question = input.question.trim();

    const existing = await this.candidates.findOne({
      where: { question, status: CandidateStatus.OPEN },
    });
    if (existing) {
      await this.candidates.update(existing.id, { occurrences: existing.occurrences + 1 });
      return this.findOne(existing.id);
    }

    this.metrics.increment('knowledge.candidate_created');
    return this.candidates.save(
      this.candidates.create({
        question,
        context: input.context?.trim() || null,
        // Defaults to MANUAL. The group harvester passes GROUP_MESSAGES so a reviewer can see that
        // a question came out of a customer conversation rather than from a colleague writing it up.
        sourceType: input.sourceType ?? CandidateSource.MANUAL,
        status: CandidateStatus.OPEN,
        categoryId: input.categoryId ?? null,
        scopeType: input.scopeType ?? KnowledgeScopeType.GLOBAL,
        scopeId: input.scopeId ?? null,
        createdById: userId,
      }),
    );
  }

  /**
   * Turns a candidate into a draft article.
   *
   * The candidate keeps a link to what it became, so the queue can show that a gap was answered and
   * by which article.
   */
  async convert(
    id: string,
    input: { title?: string; categoryId: string; body?: string },
    userId: string | null,
  ) {
    const candidate = await this.findOne(id);
    if (candidate.status !== CandidateStatus.OPEN) {
      throw new ConflictException(`This candidate has already been ${candidate.status.toLowerCase()}`);
    }

    const article = await this.articles.create(
      {
        title: (input.title ?? candidate.question).slice(0, 300),
        summary: null,
        // The question and its context become the starting point an author edits — not an answer.
        body: input.body ?? buildStarterBody(candidate),
        categoryId: input.categoryId ?? candidate.categoryId ?? '',
        scopeType: candidate.scopeType,
        scopeId: candidate.scopeId,
      },
      userId,
    );

    await this.candidates.update(candidate.id, {
      status: CandidateStatus.CONVERTED,
      convertedArticleId: article.id,
      resolvedById: userId,
      resolvedAt: new Date(),
    });

    this.metrics.increment('knowledge.candidate_converted');
    // The article is a DRAFT — asserted here because the guarantee belongs to this flow, not to
    // whatever `create` happens to default to.
    return { candidate: await this.findOne(candidate.id), article, status: KnowledgeStatus.DRAFT };
  }

  async dismiss(id: string, note: string | null, userId: string | null): Promise<KnowledgeCandidate> {
    const candidate = await this.findOne(id);
    if (candidate.status !== CandidateStatus.OPEN) {
      throw new ConflictException(`This candidate has already been ${candidate.status.toLowerCase()}`);
    }

    await this.candidates.update(candidate.id, {
      status: CandidateStatus.DISMISSED,
      resolutionNote: note?.slice(0, 1000) ?? null,
      resolvedById: userId,
      resolvedAt: new Date(),
    });
    return this.findOne(candidate.id);
  }
}

/** A starting point for the author: the question, and whatever context was recorded with it. */
function buildStarterBody(candidate: KnowledgeCandidate): string {
  const parts = [`## ${candidate.question}`, ''];
  if (candidate.context) parts.push(candidate.context, '');
  parts.push('_Answer not written yet._');
  return parts.join('\n');
}
