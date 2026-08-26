import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MetricsService } from '../../common/metrics/metrics.service';
import { AIFeedbackVerdict } from './ai-types';
import { AIFeedback } from './entities/ai-feedback.entity';

/**
 * What a human thought of an AI answer (`PROJECT_SPEC.md` §88, §136).
 *
 * Recording only. An `EDITED` verdict carries the text the agent would have sent, and that text
 * goes **nowhere near production knowledge** from here — it is evidence for a candidate somebody
 * reviews. The whole point of the learning loop is that production behaviour changes when a person
 * approves it, not when an agent is annoyed at 2am.
 */
@Injectable()
export class AIFeedbackService {
  constructor(
    @InjectRepository(AIFeedback) private readonly feedback: Repository<AIFeedback>,
    private readonly metrics: MetricsService,
  ) {}

  async record(input: {
    verdict: AIFeedbackVerdict;
    aiMessageId?: string | null;
    decisionId?: string | null;
    conversationId?: string | null;
    correctedText?: string | null;
    note?: string | null;
    userId: string | null;
  }): Promise<AIFeedback> {
    const saved = await this.feedback.save(
      this.feedback.create({
        verdict: input.verdict,
        aiMessageId: input.aiMessageId ?? null,
        decisionId: input.decisionId ?? null,
        conversationId: input.conversationId ?? null,
        correctedText: input.correctedText ?? null,
        note: input.note ?? null,
        createdById: input.userId,
      }),
    );

    this.metrics.increment('ai.feedback', { verdict: input.verdict });
    return saved;
  }

  async list(verdict?: AIFeedbackVerdict, limit = 100) {
    const [items, total] = await this.feedback.findAndCount({
      where: verdict ? { verdict } : {},
      order: { createdAt: 'DESC' },
      take: Math.min(limit, 200),
    });
    return { items, total };
  }

  /** Counts by verdict, for the AI performance report. */
  async summary(since?: Date): Promise<Record<string, number>> {
    const query = this.feedback
      .createQueryBuilder('f')
      .select('f.verdict', 'verdict')
      .addSelect('COUNT(*)', 'count')
      .groupBy('f.verdict');

    if (since) query.where('f.createdAt >= :since', { since });

    const rows = await query.getRawMany<{ verdict: string; count: string }>();
    return Object.fromEntries(rows.map((row) => [row.verdict, Number(row.count)]));
  }
}
