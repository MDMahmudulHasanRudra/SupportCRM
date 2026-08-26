import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Group } from '../groups/entities/group.entity';

/**
 * The operations dashboard: groups, AI, and human support, measured from the message table.
 *
 * ## Messages and groups are different questions
 *
 * "AI sent 184 replies" and "AI helped 27 groups" answer different things, and the second is the
 * one an operator actually asks — a hundred replies in one group is not broad coverage. Every
 * figure here is explicit about which it is: replies are `COUNT(*)`, groups are
 * `COUNT(DISTINCT "groupId")`, and the two are never substituted for one another.
 *
 * ## Configured is not effective
 *
 * "AI enabled" on this dashboard counts groups whose own switch is on. That is not the same as
 * "AI will reply here" — a profile, the monitoring state, an emergency stop or a disconnected
 * session can each still withhold it. The field is named `aiConfigured` rather than `aiEnabled` so
 * a reader is not invited to make the stronger claim, and the per-group screen is where the
 * effective answer lives.
 *
 * ## Nothing is estimated
 *
 * Every number is an aggregate over rows that exist. A day with no activity returns zero, and the
 * series returns a row for that day rather than omitting it — a chart that skips quiet days draws
 * a line straight through the gap and makes an absence look like activity.
 */

export interface CoverageSummary {
  totalGroups: number;
  monitored: number;
  /** Groups whose own AI switch is on. Not the same as "AI can reply here". */
  aiConfigured: number;
  aiDisabled: number;
  automationConfigured: number;
  patternAnalysis: number;
}

export interface SupportTotals {
  /** Messages sent. */
  replies: number;
  /** Distinct groups those messages reached. */
  groups: number;
}

export interface AiVsHumanDay {
  day: string;
  aiReplies: number;
  aiGroups: number;
  humanReplies: number;
  humanGroups: number;
}

export interface ActiveGroupRow {
  groupId: string;
  name: string | null;
  messages: number;
  aiReplies: number;
  humanSupport: number;
  lastMessageAt: string | null;
}

@Injectable()
export class OperationsAnalyticsService {
  constructor(@InjectRepository(Group) private readonly groups: Repository<Group>) {}

  /**
   * How much of the estate each capability covers.
   *
   * One statement of scalar subqueries rather than one query per card: six round trips to answer a
   * single header is the shape that stops scaling at a few thousand groups.
   */
  async coverage(): Promise<CoverageSummary> {
    const [row] = await this.groups.manager.query<Array<Record<string, string>>>(`
      SELECT
        COUNT(*)                                                    AS total_groups,
        COUNT(*) FILTER (WHERE "monitoringState" = 'MONITORED')     AS monitored,
        COUNT(*) FILTER (WHERE "aiEnabled" = true)                  AS ai_configured,
        COUNT(*) FILTER (WHERE "aiEnabled" = false)                 AS ai_disabled,
        COUNT(*) FILTER (WHERE "automationEnabled" = true)          AS automation_configured,
        COUNT(*) FILTER (WHERE "patternAnalysisEnabled" = true)     AS pattern_analysis
      FROM groups
    `);

    return {
      totalGroups: Number(row.total_groups),
      monitored: Number(row.monitored),
      aiConfigured: Number(row.ai_configured),
      aiDisabled: Number(row.ai_disabled),
      automationConfigured: Number(row.automation_configured),
      patternAnalysis: Number(row.pattern_analysis),
    };
  }

  /**
   * AI and human support totals over a window, as replies and as distinct groups.
   *
   * Both classifications come out of one scan. Two queries would double the work and could observe
   * different rows if a message landed between them.
   */
  async supportTotals(from: Date, to: Date): Promise<{ ai: SupportTotals; human: SupportTotals }> {
    const [row] = await this.groups.manager.query<Array<Record<string, string>>>(
      `
      SELECT
        COUNT(*) FILTER (WHERE classification = 'BOT_MESSAGE')                       AS ai_replies,
        COUNT(DISTINCT "groupId") FILTER (WHERE classification = 'BOT_MESSAGE')      AS ai_groups,
        COUNT(*) FILTER (WHERE classification = 'TEAM_MESSAGE')                      AS human_replies,
        COUNT(DISTINCT "groupId") FILTER (WHERE classification = 'TEAM_MESSAGE')     AS human_groups
      FROM messages
      WHERE "sentAt" >= $1 AND "sentAt" < $2
      `,
      [from, to],
    );

    return {
      ai: { replies: Number(row.ai_replies), groups: Number(row.ai_groups) },
      human: { replies: Number(row.human_replies), groups: Number(row.human_groups) },
    };
  }

  /**
   * AI against human support, per day.
   *
   * `generate_series` supplies the days so quiet ones come back as zeros. The unique-group counts
   * are per day by construction — summing them across the window would double-count a group helped
   * on two days, which is why the window totals come from {@link supportTotals} instead of from
   * adding this up.
   */
  async aiVsHumanDaily(days: number): Promise<AiVsHumanDay[]> {
    const rows = await this.groups.manager.query<Array<Record<string, string>>>(
      `
      SELECT
        to_char(d.day, 'YYYY-MM-DD')                                                 AS day,
        COUNT(m.id) FILTER (WHERE m.classification = 'BOT_MESSAGE')                  AS ai_replies,
        COUNT(DISTINCT m."groupId") FILTER (WHERE m.classification = 'BOT_MESSAGE')  AS ai_groups,
        COUNT(m.id) FILTER (WHERE m.classification = 'TEAM_MESSAGE')                 AS human_replies,
        COUNT(DISTINCT m."groupId") FILTER (WHERE m.classification = 'TEAM_MESSAGE') AS human_groups
      FROM generate_series(
             date_trunc('day', now()) - make_interval(days => $1::int - 1),
             date_trunc('day', now()),
             interval '1 day'
           ) AS d(day)
      LEFT JOIN messages m
        ON m."sentAt" >= d.day
       AND m."sentAt" <  d.day + interval '1 day'
      GROUP BY d.day
      ORDER BY d.day ASC
      `,
      [days],
    );

    return rows.map((row) => ({
      day: row.day,
      aiReplies: Number(row.ai_replies ?? 0),
      aiGroups: Number(row.ai_groups ?? 0),
      humanReplies: Number(row.human_replies ?? 0),
      humanGroups: Number(row.human_groups ?? 0),
    }));
  }

  /**
   * The busiest groups in a window.
   *
   * Aggregated and ordered in SQL, then limited — not every group returned for the browser to sort.
   * `g."id"` breaks ties so the list is stable between two identical requests.
   */
  async topActiveGroups(from: Date, to: Date, limit: number): Promise<ActiveGroupRow[]> {
    const rows = await this.groups.manager.query<Array<Record<string, string | null>>>(
      `
      SELECT
        g.id                                                              AS group_id,
        g.name                                                            AS name,
        COUNT(m.id)                                                       AS messages,
        COUNT(m.id) FILTER (WHERE m.classification = 'BOT_MESSAGE')       AS ai_replies,
        COUNT(m.id) FILTER (WHERE m.classification = 'TEAM_MESSAGE')      AS human_support,
        MAX(m."sentAt")                                                   AS last_message_at
      FROM groups g
      JOIN messages m
        ON m."groupId" = g.id
       AND m."sentAt" >= $1 AND m."sentAt" < $2
      GROUP BY g.id, g.name
      ORDER BY messages DESC, g.name ASC, g.id ASC
      LIMIT $3
      `,
      [from, to, limit],
    );

    return rows.map((row) => ({
      groupId: String(row.group_id),
      name: row.name,
      messages: Number(row.messages ?? 0),
      aiReplies: Number(row.ai_replies ?? 0),
      humanSupport: Number(row.human_support ?? 0),
      lastMessageAt: row.last_message_at,
    }));
  }

  /**
   * Everything the operations dashboard needs, in one call.
   *
   * Four statements rather than a dozen endpoints: the dashboard renders as a unit, and issuing one
   * request per card is how a page ends up making twenty round trips to show one screen.
   */
  async dashboard(days: number): Promise<{
    coverage: CoverageSummary;
    today: { ai: SupportTotals; human: SupportTotals };
    window: { days: number; ai: SupportTotals; human: SupportTotals };
    daily: AiVsHumanDay[];
    topGroups: ActiveGroupRow[];
  }> {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(midnight.getTime() + 24 * 60 * 60 * 1000);
    const windowStart = new Date(midnight.getTime() - (days - 1) * 24 * 60 * 60 * 1000);

    const [coverage, today, window, daily, topGroups] = await Promise.all([
      this.coverage(),
      this.supportTotals(midnight, tomorrow),
      this.supportTotals(windowStart, tomorrow),
      this.aiVsHumanDaily(days),
      this.topActiveGroups(windowStart, tomorrow, 10),
    ]);

    return { coverage, today, window: { days, ...window }, daily, topGroups };
  }
}
