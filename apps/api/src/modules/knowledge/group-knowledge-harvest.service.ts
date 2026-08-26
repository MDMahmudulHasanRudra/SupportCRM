import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppLogger } from '../../common/logging/app-logger';
import { Group } from '../groups/entities/group.entity';
import { KnowledgeCandidateService } from './knowledge-candidate.service';
import { CandidateSource, KnowledgeScopeType } from './knowledge-types';

/**
 * Proposes knowledge candidates from the messages of groups that opted in.
 *
 * ## What this deliberately is not
 *
 * It does not turn chat history into knowledge. It creates *candidates* — questions somebody still
 * has to read, answer and convert through the existing workflow. Nothing here writes an article,
 * nothing becomes retrievable by the AI, and a harvested candidate carries `GROUP_MESSAGES` as its
 * source so a reviewer knows it came out of a customer conversation rather than from a colleague
 * who chose to write it down. Those deserve different levels of scepticism.
 *
 * Raw messages are never sent anywhere as training data. The only thing that leaves this service is
 * a question string and a short context excerpt, stored locally, awaiting review.
 *
 * ## Opt-in, per group, enforced here
 *
 * `knowledgeContributionEnabled` is checked in the SQL rather than in the caller, so there is no
 * path that harvests a group which has not opted in — not a job, not an HTTP call, not a future
 * caller that forgets. A group that has switched it off contributes nothing, whatever else is true
 * about it.
 *
 * This is a different question from `patternAnalysisEnabled`, which decides whether a group's
 * messages are *counted* to notice repetition. Both must permit it: counting a question and
 * proposing its content as an answer are separate permissions, and a group may reasonably grant one
 * and withhold the other.
 *
 * ## Why only questions that went unanswered by AI
 *
 * A question the AI already answers well is not a knowledge gap. The ones worth a reviewer's time
 * are those that repeated *and* needed a person, which is what the decision log records.
 */

/** How many times a question must recur before it is worth a reviewer's attention. */
const MIN_OCCURRENCES = 3;

/** Below this a "question" is usually a greeting or an acknowledgement. */
const MIN_LENGTH = 15;

/** A ceiling per run, so one sweep cannot flood the review queue. */
const DEFAULT_LIMIT = 25;

export interface HarvestResult {
  /** Groups that permitted harvesting and were examined. */
  groupsConsidered: number;
  /** Distinct repeated questions found. */
  questionsFound: number;
  /** Candidates newly created. Existing open candidates have their occurrence count raised instead. */
  created: number;
  /** Candidates already open, whose occurrence count was raised. */
  updated: number;
}

@Injectable()
export class GroupKnowledgeHarvestService {
  private readonly logger = new AppLogger(GroupKnowledgeHarvestService.name);

  constructor(
    @InjectRepository(Group) private readonly groups: Repository<Group>,
    private readonly candidates: KnowledgeCandidateService,
  ) {}

  async harvest(options: { sinceDays?: number; limit?: number } = {}): Promise<HarvestResult> {
    const since = new Date(Date.now() - (options.sinceDays ?? 30) * 24 * 60 * 60 * 1000);
    const limit = Math.min(options.limit ?? DEFAULT_LIMIT, 100);

    const groupsConsidered = await this.groups.count({
      where: { knowledgeContributionEnabled: true, patternAnalysisEnabled: true },
    });
    if (groupsConsidered === 0) {
      return { groupsConsidered: 0, questionsFound: 0, created: 0, updated: 0 };
    }

    /*
     * Repeated inbound questions from opted-in groups that a person had to handle.
     *
     * Grouped by a normalised form of the text so "How do I reset my password?" and "how do i
     * reset my password" are one question rather than two near-identical review items.
     *
     * Both flags are required in the WHERE clause, not checked afterwards: filtering in SQL is what
     * makes it impossible for a caller to harvest a group that withheld permission.
     */
    const rows = await this.groups.manager.query<
      Array<{ normalised: string; occurrences: string; sample: string; group_id: string; group_name: string | null }>
    >(
      `
      SELECT
        lower(regexp_replace(trim(m.body), '\\s+', ' ', 'g'))  AS normalised,
        COUNT(*)                                               AS occurrences,
        (array_agg(m.body ORDER BY m."sentAt" DESC))[1]        AS sample,
        m."groupId"                                            AS group_id,
        MAX(g.name)                                            AS group_name
      FROM messages m
      JOIN groups g ON g.id = m."groupId"
      JOIN decision_logs d ON d."messageId" = m.id
      WHERE m.direction = 'INBOUND'
        AND m."sentAt" >= $1
        AND m.body IS NOT NULL
        AND length(trim(m.body)) >= $2
        AND d.outcome IN ('HUMAN_HANDOFF', 'NO_RESPONSE')
        AND g."knowledgeContributionEnabled" = true
        AND g."patternAnalysisEnabled" = true
      GROUP BY normalised, m."groupId"
      HAVING COUNT(*) >= $3
      ORDER BY COUNT(*) DESC, normalised ASC
      LIMIT $4
      `,
      [since, MIN_LENGTH, MIN_OCCURRENCES, limit],
    );

    let created = 0;
    let updated = 0;

    for (const row of rows) {
      const question = row.sample.slice(0, 500);

      // `create` is find-or-bump: an identical open question raises its occurrence count rather
      // than queueing the same thing twice. Scoped to the group it came from, so a reviewer answers
      // it for that group rather than globally by accident.
      const candidate = await this.candidates.create(
        {
          question,
          context: `Asked ${row.occurrences} times in ${row.group_name ?? 'a group'} and handled by a person each time.`,
          scopeType: KnowledgeScopeType.GROUP,
          scopeId: row.group_id,
          sourceType: CandidateSource.GROUP_MESSAGES,
        },
        null,
      );

      // `create` is find-or-bump. An occurrence count above one means it found an existing open
      // candidate and raised it rather than queueing the same question twice.
      if (candidate.occurrences > 1) updated += 1;
      else created += 1;
    }

    this.logger.log('Harvested knowledge candidates from opted-in groups', {
      groupsConsidered,
      questionsFound: rows.length,
      created,
      updated,
    });

    return { groupsConsidered, questionsFound: rows.length, created, updated };
  }
}
