import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppLogger } from '../../common/logging/app-logger';
import { MetricsService } from '../../common/metrics/metrics.service';
import { ActionType, ConditionType } from '../automation/automation-types';
import { AutomationCandidate, CandidateStatus } from '../automation/entities/automation-candidate.entity';
import { Message } from '../messaging/entities/message.entity';

/**
 * Where candidates come from (`PROJECT_SPEC.md` §85–§88, §135).
 *
 * The learning pipeline is conversation → analytics → **pattern detection** → candidate → human
 * review → approval → production. This service is the pattern-detection step, and it is deliberately
 * the dullest possible version of it: group the messages that ended in an escalation by their
 * normalised text, and propose the ones that keep coming back.
 *
 * Boring is the point. §87 forbids training production behaviour from raw conversations, and a
 * clustering model would produce proposals a reviewer cannot check. "This exact question was asked
 * eleven times and a human answered it every time" is a proposal somebody can judge in five seconds,
 * and the eleven messages are attached so they can.
 *
 * Nothing here publishes anything. A candidate has no path to a customer.
 */

/** Below this, a repeat is a coincidence rather than a pattern worth an operator's attention. */
const MIN_OCCURRENCES = 3;
/** Ignore anything shorter — "ok", "hi", "?" repeat constantly and mean nothing. */
const MIN_LENGTH = 12;

@Injectable()
export class CandidateDetectorService {
  private readonly logger = new AppLogger(CandidateDetectorService.name);

  constructor(
    @InjectRepository(AutomationCandidate) private readonly candidates: Repository<AutomationCandidate>,
    @InjectRepository(Message) private readonly messages: Repository<Message>,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Looks for repeated questions that a human had to answer, and proposes rules for them.
   *
   * Idempotent by title: re-running updates the occurrence count on an existing pending candidate
   * rather than filling the review queue with copies of the same proposal. A candidate somebody has
   * already rejected is left alone — re-proposing it every night is how a review queue gets ignored.
   */
  async detect(options: { sinceDays?: number; limit?: number } = {}): Promise<{
    examined: number;
    created: number;
    updated: number;
  }> {
    const since = new Date(Date.now() - (options.sinceDays ?? 30) * 24 * 60 * 60 * 1000);

    // Escalated inbound messages, grouped by what the customer actually typed. Joined through
    // decision_logs because that is where "this needed a human" is recorded.
    const rows = await this.messages.manager.query<
      Array<{ normalised: string; occurrences: string; sample: string; message_ids: string[] }>
    >(
      `
      SELECT
        lower(regexp_replace(trim(m.body), '\\s+', ' ', 'g'))     AS normalised,
        COUNT(*)                                                  AS occurrences,
        (array_agg(m.body ORDER BY m."sentAt" DESC))[1]           AS sample,
        (array_agg(m.id::text ORDER BY m."sentAt" DESC))[1:5]     AS message_ids
      FROM messages m
      JOIN decision_logs d ON d."messageId" = m.id
      WHERE m.direction = 'INBOUND'
        AND m."sentAt" >= $1
        AND m.body IS NOT NULL
        AND length(trim(m.body)) >= $2
        AND d.outcome IN ('HUMAN_HANDOFF', 'NO_RESPONSE')
      GROUP BY normalised
      HAVING COUNT(*) >= $3
      ORDER BY COUNT(*) DESC
      LIMIT $4
      `,
      [since, MIN_LENGTH, MIN_OCCURRENCES, options.limit ?? 25],
    );

    let created = 0;
    let updated = 0;

    for (const row of rows) {
      const title = `Repeated question: ${row.sample.slice(0, 120)}`;
      const occurrences = Number(row.occurrences);

      const existing = await this.candidates.findOne({ where: { title } });

      if (existing) {
        // A rejected or published candidate stays as it is. Re-proposing something a human has
        // already ruled on is how a review queue becomes noise people stop reading.
        if (existing.status !== CandidateStatus.PENDING) continue;

        await this.candidates.update(existing.id, {
          occurrences,
          sampleMessageIds: row.message_ids,
        });
        updated += 1;
        continue;
      }

      await this.candidates.save(
        this.candidates.create({
          title,
          rationale:
            `This was asked ${occurrences} times in the last ${options.sinceDays ?? 30} days and ` +
            `every time it went to a person. A rule would answer it immediately — but only if the ` +
            `answer below is right, which is what this review is for.`,
          source: 'PATTERN',
          // A proposal, in the same shape a rule uses. The reply is deliberately left as a prompt
          // rather than invented: the system knows the question repeats, not what the answer is.
          proposedConditions: {
            match: 'ALL',
            conditions: [{ type: ConditionType.NORMALIZED, value: row.normalised.slice(0, 200) }],
          } as never,
          proposedActions: [{ type: ActionType.SEND_MESSAGE, value: '' }] as never,
          occurrences,
          sampleMessageIds: row.message_ids,
          status: CandidateStatus.PENDING,
        }),
      );
      created += 1;
    }

    this.metrics.increment('candidates.detected', {}, created);
    if (created > 0 || updated > 0) {
      this.logger.log('Automation candidates refreshed from repeated escalations', {
        examined: rows.length,
        created,
        updated,
      });
    }

    return { examined: rows.length, created, updated };
  }

  /** The messages behind a candidate, so a reviewer can read what customers actually wrote. */
  async evidenceFor(candidateId: string): Promise<Message[]> {
    const candidate = await this.candidates.findOne({ where: { id: candidateId } });
    if (!candidate?.sampleMessageIds?.length) return [];

    return this.messages.find({
      where: candidate.sampleMessageIds.map((id) => ({ id })),
      order: { sentAt: 'DESC' },
      take: 10,
    });
  }
}
