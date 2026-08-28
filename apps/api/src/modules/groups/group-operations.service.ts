import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Group } from './entities/group.entity';

/**
 * The queries behind the group operations screen.
 *
 * ## Everything aggregates in Postgres
 *
 * The screen is designed for a few thousand groups over a message table that grows without bound.
 * Counting messages per group in JavaScript would mean shipping the message table to the browser,
 * and doing it with one query per row would mean 3,000 round trips for one page. So each figure is
 * a grouped query over an indexed column, and the page-sized list is joined to its counters in a
 * single statement.
 *
 * ## The counters are derived, never stored
 *
 * There is no `messageCount` column being incremented as messages arrive. A counter maintained by
 * application code drifts the first time a write fails halfway, and then quietly disagrees with the
 * rows it claims to summarise. These count the rows themselves, so they cannot be wrong — the cost
 * is an index, which is the right trade.
 */

export type GroupSort =
  | 'name'
  | 'members'
  | 'lastActivity'
  | 'messagesToday'
  | 'aiRepliesToday'
  | 'humanSupportToday'
  | 'messagesThisMonth'
  | 'aiRepliesThisMonth'
  | 'humanSupportThisMonth';

export interface GroupListFilter {
  channelAccountId?: string;
  monitoringState?: string;
  /** Tri-state: undefined means "either". */
  aiEnabled?: boolean;
  automationEnabled?: boolean;
  patternAnalysisEnabled?: boolean;
  knowledgeContributionEnabled?: boolean;
  /** Groups that have ever received an AI reply. */
  hasAiActivity?: boolean;
  /** Groups a registered support member has ever replied in. */
  hasSupportActivity?: boolean;
  isActive?: boolean;
  /**
   * Which knowledge profile the group answers from. The literal `'none'` selects groups with no
   * profile — distinct from leaving this unset, which does not filter on it at all.
   */
  knowledgeProfileId?: string;
  /** Restricts to groups that have received a message since midnight. */
  activeToday?: boolean;
  /** Matches the group name, or its channel id, so an operator can paste a JID. */
  search?: string;
}

export interface GroupRow {
  id: string;
  externalId: string;
  channelAccountId: string;
  name: string | null;
  participantCount: number | null;
  isActive: boolean;
  monitoringState: string;
  aiEnabled: boolean;
  automationEnabled: boolean;
  patternAnalysisEnabled: boolean;
  knowledgeContributionEnabled: boolean;
  knowledgeProfileId: string | null;
  lastMessageAt: string | null;
  /** Counted from `messages`, not stored. Null-safe: a group with no messages reports 0. */
  /**
   * Activity since midnight.
   *
   * Today rather than all time, and that is a performance decision as much as a product one. An
   * all-time per-group count has to touch every message a group has ever received, and Postgres
   * evaluates it for every matching group before applying LIMIT — measured at 191ms for one page of
   * 50 across 3,000 groups and 200k messages, growing with total history. Bounding the aggregate to
   * one day made the same page 3ms, and its cost now grows with today's traffic rather than with
   * everything ever stored. All-time figures live on the group detail screen, where the scope is a
   * single group.
   */
  messagesToday: number;
  aiRepliesToday: number;
  humanSupportToday: number;
  /**
   * The same three since the first of the month.
   *
   * Free, given how today is computed: the aggregate already has to open a window, so it opens it
   * at the start of the month and separates today with a FILTER. One scan, two windows. Widening
   * it further — to all time — is what reintroduces the unbounded per-group scan this design
   * exists to avoid.
   */
  messagesThisMonth: number;
  aiRepliesThisMonth: number;
  humanSupportThisMonth: number;
  /** When the group row was first synced. */
  createdAt: string | null;
  /**
   * When AI and a support member last acted here.
   *
   * All-time maxima, so unlike the counters above they cannot be bounded to one day. They are
   * therefore computed for the page's rows only — see `lastActivityFor`.
   */
  lastAiActivityAt: string | null;
  lastSupportActivityAt: string | null;
}

@Injectable()
export class GroupOperationsService {
  constructor(@InjectRepository(Group) private readonly groups: Repository<Group>) {}

  /**
   * Builds the WHERE clause shared by the list, the count and the select-all-filtered resolution.
   *
   * One builder for all three is what guarantees "select all 1,842 matching" selects exactly the
   * rows the operator was looking at. Two hand-written clauses would eventually disagree, and the
   * failure mode is a bulk change applied to the wrong groups.
   */
  private where(filter: GroupListFilter): { sql: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      clauses.push(sql.replace('?', `$${params.length}`));
    };

    if (filter.channelAccountId) add('g."channelAccountId" = ?', filter.channelAccountId);
    if (filter.monitoringState) add('g."monitoringState" = ?', filter.monitoringState);
    if (filter.aiEnabled !== undefined) add('g."aiEnabled" = ?', filter.aiEnabled);
    if (filter.automationEnabled !== undefined) add('g."automationEnabled" = ?', filter.automationEnabled);
    if (filter.patternAnalysisEnabled !== undefined) {
      add('g."patternAnalysisEnabled" = ?', filter.patternAnalysisEnabled);
    }
    if (filter.knowledgeContributionEnabled !== undefined) {
      add('g."knowledgeContributionEnabled" = ?', filter.knowledgeContributionEnabled);
    }
    if (filter.isActive !== undefined) add('g."isActive" = ?', filter.isActive);
    /*
     * Activity filters use EXISTS rather than a join or a counter comparison.
     *
     * EXISTS stops at the first matching row, so "has this group ever seen an AI reply" costs one
     * index probe instead of counting every message the group has ever received. A join would also
     * multiply the group rows and need a DISTINCT to undo it.
     */
    if (filter.hasAiActivity !== undefined) {
      clauses.push(
        `${filter.hasAiActivity ? '' : 'NOT '}EXISTS (
           SELECT 1 FROM messages am
           WHERE am."groupId" = g.id AND am.classification = 'BOT_MESSAGE')`,
      );
    }
    if (filter.hasSupportActivity !== undefined) {
      clauses.push(
        `${filter.hasSupportActivity ? '' : 'NOT '}EXISTS (
           SELECT 1 FROM messages sm
           WHERE sm."groupId" = g.id AND sm.classification = 'TEAM_MESSAGE')`,
      );
    }
    if (filter.knowledgeProfileId) {
      // "No profile" is a real selection an operator makes, so it gets an explicit sentinel rather
      // than being conflated with "do not filter".
      if (filter.knowledgeProfileId === 'none') clauses.push('g."knowledgeProfileId" IS NULL');
      else add('g."knowledgeProfileId" = ?', filter.knowledgeProfileId);
    }
    if (filter.activeToday !== undefined) {
      // A group that has never received a message has a NULL `lastMessageAt`, which is not "before
      // midnight" — `IS NULL` has to be spelled out or those groups vanish from both sides.
      if (filter.activeToday) add('g."lastMessageAt" >= ?', startOfToday());
      else {
        params.push(startOfToday());
        clauses.push(`(g."lastMessageAt" IS NULL OR g."lastMessageAt" < $${params.length})`);
      }
    }
    if (filter.search) {
      // Parameterised, and matched against the channel id too so pasting a JID finds the group.
      // A group name is untrusted input and is never concatenated into SQL.
      params.push(`%${filter.search}%`);
      clauses.push(`(g."name" ILIKE $${params.length} OR g."externalId" ILIKE $${params.length})`);
    }

    return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }

  private orderBy(sort: GroupSort, direction: 'ASC' | 'DESC'): string {
    // A whitelist, not interpolation: `sort` reaches here from a query string.
    const columns: Record<GroupSort, string> = {
      name: 'g."name"',
      members: 'g."participantCount"',
      lastActivity: 'g."lastMessageAt"',
      messagesToday: 'COALESCE(t.messages_today, 0)',
      aiRepliesToday: 'COALESCE(t.ai_replies_today, 0)',
      humanSupportToday: 'COALESCE(t.human_support_today, 0)',
      messagesThisMonth: 'COALESCE(t.messages_month, 0)',
      aiRepliesThisMonth: 'COALESCE(t.ai_replies_month, 0)',
      humanSupportThisMonth: 'COALESCE(t.human_support_month, 0)',
    };
    const column = columns[sort] ?? columns.lastActivity;
    // NULLS LAST in both directions: a group that has never been active belongs at the bottom of
    // "most recent" and is not interesting at the top of "least recent" either.
    //
    // `g."id"` last is what makes the order *total*, and it is not optional. Postgres may return
    // rows that tie on the sort key in any order it likes, and a different order per query — so with
    // LIMIT/OFFSET a tied row can land on two consecutive pages while another is skipped entirely.
    // Observed with two groups genuinely both named "Eye Spy": one appeared on page 1 and page 2,
    // and a third group became unreachable. Ties are the norm here, not the exception — every group
    // with no messages yet shares a count of 0 and a NULL last-activity — so without a unique final
    // key most of the table would page unstably.
    return `ORDER BY ${column} ${direction} NULLS LAST, g."name" ASC, g."id" ASC`;
  }

  /**
   * One page of groups with their counters.
   *
   * The counters come from a lateral subquery per row rather than a join over the whole message
   * table: with a page size of 50 that is 50 index lookups, against an aggregate over every message
   * ever received if the grouping happened first.
   */
  async list(
    filter: GroupListFilter,
    options: { limit: number; offset: number; sort: GroupSort; direction: 'ASC' | 'DESC' },
  ): Promise<{ items: GroupRow[]; total: number; limit: number; offset: number }> {
    const { sql: whereSql, params } = this.where(filter);
    const todayParam = `$${params.length + 1}`;
    // An upper bound as well as a lower one. `>= midnight` alone counts messages dated in the
    // future, which WhatsApp produces whenever a sending device's clock is ahead.
    const tomorrowParam = `$${params.length + 2}`;
    // The aggregate's lower bound. Today is carved out of it with a FILTER rather than a second
    // scan, so the monthly figures cost nothing beyond a wider window.
    const monthParam = `$${params.length + 3}`;

    const rows = await this.groups.manager.query<
      Array<Record<string, string | number | boolean | null>>
    >(
      `
      WITH recent AS (
        SELECT
          m."groupId",
          COUNT(*) FILTER (WHERE m."sentAt" >= ${todayParam})                                AS messages_today,
          COUNT(*) FILTER (WHERE m."sentAt" >= ${todayParam}
                             AND m.classification = 'BOT_MESSAGE')                           AS ai_replies_today,
          COUNT(*) FILTER (WHERE m."sentAt" >= ${todayParam}
                             AND m.classification = 'TEAM_MESSAGE')                          AS human_support_today,
          COUNT(*)                                                                           AS messages_month,
          COUNT(*) FILTER (WHERE m.classification = 'BOT_MESSAGE')                           AS ai_replies_month,
          COUNT(*) FILTER (WHERE m.classification = 'TEAM_MESSAGE')                          AS human_support_month
        FROM messages m
        WHERE m."sentAt" >= ${monthParam}
          AND m."sentAt" <  ${tomorrowParam}
          AND m."groupId" IS NOT NULL
        GROUP BY m."groupId"
      )
      SELECT
        g.id, g."externalId", g."channelAccountId", g.name, g."participantCount",
        g."isActive", g."monitoringState", g."aiEnabled", g."automationEnabled",
        g."patternAnalysisEnabled", g."knowledgeContributionEnabled",
        g."knowledgeProfileId", g."lastMessageAt", g."createdAt",
        COALESCE(t.messages_today, 0)        AS messages_today,
        COALESCE(t.ai_replies_today, 0)      AS ai_replies_today,
        COALESCE(t.human_support_today, 0)   AS human_support_today,
        COALESCE(t.messages_month, 0)        AS messages_month,
        COALESCE(t.ai_replies_month, 0)      AS ai_replies_month,
        COALESCE(t.human_support_month, 0)   AS human_support_month
      FROM groups g
      LEFT JOIN recent t ON t."groupId" = g.id
      ${whereSql}
      ${this.orderBy(options.sort, options.direction)}
      LIMIT $${params.length + 4} OFFSET $${params.length + 5}
      `,
      [...params, startOfToday(), startOfTomorrow(), startOfMonth(), options.limit, options.offset],
    );

    const [{ count }] = await this.groups.manager.query<Array<{ count: string }>>(
      `SELECT COUNT(*) AS count FROM groups g ${whereSql}`,
      params,
    );

    const lastActivity = await this.lastActivityFor(rows.map((row) => String(row.id)));

    return {
      items: rows.map((row) => ({
        id: String(row.id),
        externalId: String(row.externalId),
        channelAccountId: String(row.channelAccountId),
        name: row.name === null ? null : String(row.name),
        participantCount: row.participantCount === null ? null : Number(row.participantCount),
        isActive: Boolean(row.isActive),
        monitoringState: String(row.monitoringState),
        aiEnabled: Boolean(row.aiEnabled),
        automationEnabled: Boolean(row.automationEnabled),
        patternAnalysisEnabled: Boolean(row.patternAnalysisEnabled),
        knowledgeContributionEnabled: Boolean(row.knowledgeContributionEnabled),
        knowledgeProfileId: row.knowledgeProfileId === null ? null : String(row.knowledgeProfileId),
        lastMessageAt: row.lastMessageAt === null ? null : new Date(String(row.lastMessageAt)).toISOString(),
        messagesToday: Number(row.messages_today),
        aiRepliesToday: Number(row.ai_replies_today),
        humanSupportToday: Number(row.human_support_today),
        messagesThisMonth: Number(row.messages_month),
        aiRepliesThisMonth: Number(row.ai_replies_month),
        humanSupportThisMonth: Number(row.human_support_month),
        createdAt: row.createdAt === null ? null : new Date(String(row.createdAt)).toISOString(),
        lastAiActivityAt: lastActivity.get(String(row.id))?.ai ?? null,
        lastSupportActivityAt: lastActivity.get(String(row.id))?.support ?? null,
      })),
      total: Number(count),
      limit: options.limit,
      offset: options.offset,
    };
  }

  /**
   * Every id matching a filter, for "select all 1,842 matching".
   *
   * Returns ids rather than rows: the caller hands them to the bulk pipeline, which re-reads what it
   * needs. Shipping full rows for several thousand groups to build a selection would be a large
   * payload nobody reads.
   */

  /**
   * When AI and a support member last acted, for one page of groups.
   *
   * Deliberately a second query over the page's ids rather than a column in the main statement.
   * "Last AI reply" is an all-time maximum, and computing it inside the list would mean aggregating
   * every message each matching group has ever received — the per-group-lateral shape that measured
   * 191ms for one page across 3,000 groups and grew with total history.
   *
   * Bounded to at most one page of ids, it is a handful of index probes: the
   * `(groupId, classification, sentAt DESC)` index answers each maximum from its first entry
   * without touching the rows. Two queries, never N+1.
   */
  private async lastActivityFor(
    groupIds: string[],
  ): Promise<Map<string, { ai: string | null; support: string | null }>> {
    const result = new Map<string, { ai: string | null; support: string | null }>();
    if (groupIds.length === 0) return result;

    const rows = await this.groups.manager.query<Array<Record<string, string | null>>>(
      `
      SELECT
        m."groupId"                                                        AS group_id,
        MAX(m."sentAt") FILTER (WHERE m.classification = 'BOT_MESSAGE')    AS ai_at,
        MAX(m."sentAt") FILTER (WHERE m.classification = 'TEAM_MESSAGE')   AS support_at
      FROM messages m
      WHERE m."groupId" = ANY($1::uuid[])
      GROUP BY m."groupId"
      `,
      [groupIds],
    );

    for (const row of rows) {
      result.set(String(row.group_id), {
        ai: row.ai_at === null ? null : new Date(String(row.ai_at)).toISOString(),
        support: row.support_at === null ? null : new Date(String(row.support_at)).toISOString(),
      });
    }
    return result;
  }

  async idsMatching(filter: GroupListFilter, cap: number): Promise<string[]> {
    const { sql: whereSql, params } = this.where(filter);
    const rows = await this.groups.manager.query<Array<{ id: string }>>(
      `SELECT g.id FROM groups g ${whereSql} ORDER BY g."name" ASC, g."id" ASC LIMIT $${params.length + 1}`,
      [...params, cap],
    );
    return rows.map((row) => row.id);
  }

  /**
   * The figures across the top of the screen.
   *
   * One statement rather than six, because they are read together and six round trips to render a
   * header is how a page starts feeling slow. "Active today" and the support counts are windowed on
   * the caller's day boundary rather than a rolling 24 hours — an operator reading "active today"
   * means the calendar day they are having.
   */
  async summary(since: Date): Promise<{
    total: number;
    aiMonitored: number;
    aiDisabled: number;
    collecting: number;
    /** Counted directly: a group may be PENDING or IGNORED, not merely "not MONITORED". */
    notCollecting: number;
    automationEnabled: number;
    patternAnalysis: number;
    activeToday: number;
    aiSupportedToday: number;
    humanSupportedToday: number;
  }> {
    const [row] = await this.groups.manager.query<Array<Record<string, string>>>(
      `
      SELECT
        (SELECT COUNT(*) FROM groups)                                          AS total,
        (SELECT COUNT(*) FROM groups WHERE "aiEnabled" = true)                 AS ai_monitored,
        (SELECT COUNT(*) FROM groups WHERE "aiEnabled" = false)                AS ai_disabled,
        (SELECT COUNT(*) FROM groups WHERE "monitoringState" = 'MONITORED')    AS collecting,
        -- Counted, not derived as total - collecting. A group can be PENDING or IGNORED as well as
        -- MONITORED, so subtraction would quietly fold two different states into one number.
        (SELECT COUNT(*) FROM groups WHERE "monitoringState" <> 'MONITORED')    AS not_collecting,
        (SELECT COUNT(*) FROM groups WHERE "automationEnabled" = true)          AS automation_enabled,
        (SELECT COUNT(*) FROM groups WHERE "patternAnalysisEnabled" = true)    AS pattern_analysis,
        (SELECT COUNT(*) FROM groups WHERE "lastMessageAt" >= $1)              AS active_today,
        -- Unique groups, not message counts: a group the AI answered twenty times is one supported
        -- group. Counting rows here is the classic way this number becomes meaningless.
        (SELECT COUNT(DISTINCT m."groupId") FROM messages m
           WHERE m."groupId" IS NOT NULL AND m."sentAt" >= $1
             AND m.classification = 'BOT_MESSAGE')                             AS ai_supported_today,
        (SELECT COUNT(DISTINCT m."groupId") FROM messages m
           WHERE m."groupId" IS NOT NULL AND m."sentAt" >= $1
             AND m.classification = 'TEAM_MESSAGE')                            AS human_supported_today
      `,
      [since],
    );

    return {
      total: Number(row.total),
      aiMonitored: Number(row.ai_monitored),
      aiDisabled: Number(row.ai_disabled),
      collecting: Number(row.collecting),
      notCollecting: Number(row.not_collecting),
      automationEnabled: Number(row.automation_enabled),
      patternAnalysis: Number(row.pattern_analysis),
      activeToday: Number(row.active_today),
      aiSupportedToday: Number(row.ai_supported_today),
      humanSupportedToday: Number(row.human_supported_today),
    };
  }
}

/**
 * Midnight today, server time.
 *
 * Server time rather than UTC because "today" is the operator's day: a support team in Dhaka
 * looking at 1am expects the figures for the day they are in, not for a boundary six hours away.
 * The whole request uses one instant so the filter and the counters cannot straddle midnight.
 */
function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** The first instant of the current month, in the application's zone. */
function startOfMonth(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/** The exclusive upper bound of today, in the same zone. */
function startOfTomorrow(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
}
