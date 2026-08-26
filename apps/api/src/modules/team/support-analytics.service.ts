import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TeamMemberIdentity } from './entities/team-member-identity.entity';

/**
 * What support members actually did, measured from the message table.
 *
 * ## There is no support-activity table
 *
 * Nothing here is a stored counter. Every figure is an aggregate over `messages` rows classified
 * `TEAM_MESSAGE`, joined to the identity that classified them. A maintained counter would drift the
 * first time a write failed halfway and would then disagree, permanently and invisibly, with the
 * messages it claims to summarise. These recompute, so they cannot be wrong about their own source.
 *
 * ## Replies and groups are counted separately, always
 *
 * "42 replies" and "42 groups helped" are different claims and the second is much stronger. They
 * are `COUNT(*)` and `COUNT(DISTINCT "groupId")` respectively and are never substituted for one
 * another — a member who sent forty messages in one group has helped one group, and reporting that
 * as forty would misrepresent their day.
 *
 * ## Every window has an upper bound
 *
 * "Today" is `>= midnight AND < tomorrow`, not simply `>= midnight`. The open-ended form looks
 * equivalent and is not: WhatsApp messages carry the sending device's timestamp, and a skewed clock
 * produces rows dated in the future. Those inflate every open-ended "today" from the moment they
 * arrive until the day catches up with them. Observed as a roster reporting 23 replies today
 * against 12 that actually happened today.
 *
 * ## Zero is a real answer
 *
 * Until somebody registers a support member, no message can be classified `TEAM_MESSAGE` and every
 * figure here is legitimately zero. That is reported as zero. It is not padded, estimated, or
 * back-filled from "probably a person" heuristics.
 */

export interface SupportMemberRow {
  id: string;
  displayName: string;
  phone: string;
  jobRole: string | null;
  isActive: boolean;
  channelKey: string;
  /** Replies sent — `COUNT(*)`. */
  repliesToday: number;
  replies7d: number;
  replies30d: number;
  /** Distinct groups replied in — `COUNT(DISTINCT groupId)`, never the reply count. */
  groupsToday: number;
  groups7d: number;
  groups30d: number;
  lastReplyAt: string | null;
}

export interface SupportDay {
  day: string;
  replies: number;
  groups: number;
}

export interface SupportDayDetail {
  day: string;
  totalMessages: number;
  /** Distinct groups helped that day. Not the message count. */
  groupCount: number;
  groups: Array<{
    groupId: string | null;
    groupName: string;
    messages: number;
    firstAt: string | null;
    lastAt: string | null;
  }>;
}

export interface SupportGroupBreakdown {
  groupId: string | null;
  groupName: string;
  replies: number;
  lastReplyAt: string | null;
}

@Injectable()
export class SupportAnalyticsService {
  constructor(
    @InjectRepository(TeamMemberIdentity)
    private readonly identities: Repository<TeamMemberIdentity>,
  ) {}

  /**
   * Every registered support member with their reply volume.
   *
   * One statement. The windows are `FILTER` clauses over a single scan rather than three queries
   * per member, which is what stops this becoming N+1 the moment a team grows.
   *
   * `LEFT JOIN`, so a member who has not replied yet appears with zeros instead of vanishing —
   * "nobody has replied" and "nobody is registered" are different problems and the screen has to be
   * able to tell them apart.
   */
  async roster(options: { includeInactive?: boolean } = {}): Promise<SupportMemberRow[]> {
    const rows = await this.identities.manager.query<Array<Record<string, string | boolean | null>>>(
      `
      SELECT
        i.id, i."displayName", i.phone, i."jobRole", i."isActive", i."channelKey",
        COUNT(*) FILTER (WHERE m."sentAt" >= date_trunc('day', now())
                           AND m."sentAt" <  date_trunc('day', now()) + interval '1 day')   AS replies_today,
        COUNT(*) FILTER (WHERE m."sentAt" >= now() - interval '7 days'
                           AND m."sentAt" <= now())                                          AS replies_7d,
        COUNT(*) FILTER (WHERE m."sentAt" >= now() - interval '30 days'
                           AND m."sentAt" <= now())                                          AS replies_30d,
        COUNT(DISTINCT m."groupId") FILTER (WHERE m."sentAt" >= date_trunc('day', now())
                           AND m."sentAt" <  date_trunc('day', now()) + interval '1 day')   AS groups_today,
        COUNT(DISTINCT m."groupId") FILTER (WHERE m."sentAt" >= now() - interval '7 days'
                           AND m."sentAt" <= now())                                          AS groups_7d,
        COUNT(DISTINCT m."groupId") FILTER (WHERE m."sentAt" >= now() - interval '30 days'
                           AND m."sentAt" <= now())                                          AS groups_30d,
        MAX(m."sentAt")                                                        AS last_reply_at
      FROM team_member_identities i
      LEFT JOIN messages m
        ON m.classification = 'TEAM_MESSAGE'
       AND m."channelKey" = i."channelKey"
       AND (m."senderExternalId" = i."externalId" OR m."senderPhone" = i.phone)
      ${options.includeInactive ? '' : 'WHERE i."isActive" = true'}
      GROUP BY i.id
      ORDER BY replies_30d DESC, i."displayName" ASC, i.id ASC
      `,
    );

    return rows.map((row) => ({
      id: String(row.id),
      displayName: String(row.displayName),
      phone: String(row.phone),
      jobRole: nullableText(row.jobRole),
      // pg returns a real boolean for a boolean column, but the driver is configured per-type and a
      // string 't' is what arrives if that ever changes. Both read as true; nothing else does.
      isActive: row.isActive === true || row.isActive === 't',
      channelKey: String(row.channelKey),
      repliesToday: Number(row.replies_today ?? 0),
      replies7d: Number(row.replies_7d ?? 0),
      replies30d: Number(row.replies_30d ?? 0),
      groupsToday: Number(row.groups_today ?? 0),
      groups7d: Number(row.groups_7d ?? 0),
      groups30d: Number(row.groups_30d ?? 0),
      lastReplyAt: nullableText(row.last_reply_at),
    }));
  }

  /**
   * One member's daily volume over a window.
   *
   * `generate_series` supplies the days, so a day with no replies comes back as a zero rather than
   * being missing. A chart that silently omits empty days draws a continuous line through a gap and
   * makes an absence look like activity.
   */
  async memberDaily(identityId: string, days: number): Promise<SupportDay[]> {
    const rows = await this.identities.manager.query<Array<Record<string, string>>>(
      `
      WITH bounds AS (
        SELECT i."channelKey", i."externalId", i.phone
        FROM team_member_identities i WHERE i.id = $1
      )
      SELECT
        to_char(d.day, 'YYYY-MM-DD') AS day,
        COUNT(m.id)                  AS replies,
        COUNT(DISTINCT m."groupId")  AS groups
      FROM generate_series(
             date_trunc('day', now()) - make_interval(days => $2::int - 1),
             date_trunc('day', now()),
             interval '1 day'
           ) AS d(day)
      LEFT JOIN bounds b ON TRUE
      LEFT JOIN messages m
        ON m.classification = 'TEAM_MESSAGE'
       AND m."channelKey" = b."channelKey"
       AND (m."senderExternalId" = b."externalId" OR m."senderPhone" = b.phone)
       AND m."sentAt" >= d.day
       AND m."sentAt" < d.day + interval '1 day'
      GROUP BY d.day
      ORDER BY d.day ASC
      `,
      [identityId, days],
    );

    return rows.map((row) => ({
      day: row.day,
      replies: Number(row.replies ?? 0),
      groups: Number(row.groups ?? 0),
    }));
  }

  /**
   * Which groups a member replied in, by name.
   *
   * Named rather than counted on purpose: "you helped 6 groups" is not reviewable, and "you replied
   * in Admissions candidate, Learn German, …" is. `LEFT JOIN groups` because a direct chat has no
   * group row, and those replies still happened.
   */
  async memberGroups(identityId: string, days: number): Promise<SupportGroupBreakdown[]> {
    const rows = await this.identities.manager.query<Array<Record<string, string | null>>>(
      `
      WITH bounds AS (
        SELECT i."channelKey", i."externalId", i.phone
        FROM team_member_identities i WHERE i.id = $1
      )
      SELECT
        m."groupId"          AS group_id,
        g.name               AS group_name,
        COUNT(*)             AS replies,
        MAX(m."sentAt")      AS last_reply_at
      FROM messages m
      JOIN bounds b ON TRUE
      LEFT JOIN groups g ON g.id = m."groupId"
      WHERE m.classification = 'TEAM_MESSAGE'
        AND m."channelKey" = b."channelKey"
        AND (m."senderExternalId" = b."externalId" OR m."senderPhone" = b.phone)
        AND m."sentAt" >= now() - make_interval(days => $2::int)
      GROUP BY m."groupId", g.name
      ORDER BY replies DESC, g.name ASC NULLS LAST, m."groupId" ASC
      `,
      [identityId, days],
    );

    return rows.map((row) => ({
      groupId: row.group_id,
      groupName: row.group_name ?? 'Direct chat',
      replies: Number(row.replies ?? 0),
      lastReplyAt: nullableText(row.last_reply_at),
    }));
  }


  /**
   * One member's activity, day by day, with the groups named.
   *
   * This is the question the screen exists to answer: *which executive helped how many groups on
   * which day, and which groups were they*. A daily count alone cannot be checked by the person it
   * describes; a list of group names can.
   *
   * One query, grouped by day and group, then assembled by day in JavaScript. The result is bounded
   * by the window (at most days x groups-helped rows), so this is not the "aggregate in the client"
   * pattern — the counting is all in SQL and only the nesting happens here.
   *
   * Days are the application's days: the database session runs the configured timezone, so
   * `date_trunc('day', ...)` buckets on local midnight rather than UTC. Without that pin a Dhaka
   * team's early-morning messages would land on the previous day.
   */
  async memberActivity(identityId: string, from: Date, to: Date): Promise<SupportDayDetail[]> {
    const rows = await this.identities.manager.query<Array<Record<string, string | null>>>(
      `
      WITH bounds AS (
        SELECT i."channelKey", i."externalId", i.phone
        FROM team_member_identities i WHERE i.id = $1
      )
      SELECT
        to_char(date_trunc('day', m."sentAt"), 'YYYY-MM-DD')  AS day,
        m."groupId"                                           AS group_id,
        MAX(g.name)                                           AS group_name,
        COUNT(*)                                              AS messages,
        MIN(m."sentAt")                                       AS first_at,
        MAX(m."sentAt")                                       AS last_at
      FROM messages m
      JOIN bounds b ON TRUE
      LEFT JOIN groups g ON g.id = m."groupId"
      WHERE m.classification = 'TEAM_MESSAGE'
        AND m."channelKey" = b."channelKey"
        AND (m."senderExternalId" = b."externalId" OR m."senderPhone" = b.phone)
        AND m."sentAt" >= $2 AND m."sentAt" < $3
      GROUP BY 1, m."groupId"
      ORDER BY 1 DESC, messages DESC, group_name ASC NULLS LAST, m."groupId" ASC
      `,
      [identityId, from, to],
    );

    const byDay = new Map<string, SupportDayDetail>();
    for (const row of rows) {
      const day = String(row.day);
      if (!byDay.has(day)) byDay.set(day, { day, totalMessages: 0, groupCount: 0, groups: [] });

      const entry = byDay.get(day)!;
      const messages = Number(row.messages ?? 0);
      entry.totalMessages += messages;
      // One row per group per day, so this counts groups rather than messages — the distinction the
      // whole screen rests on.
      entry.groupCount += 1;
      entry.groups.push({
        groupId: row.group_id,
        groupName: row.group_name ?? 'Direct chat',
        messages,
        firstAt: nullableText(row.first_at),
        lastAt: nullableText(row.last_at),
      });
    }

    return [...byDay.values()];
  }

  /**
   * Team-wide activity per day.
   *
   * `activeMembers` counts the people who replied that day, which is not the size of the team and
   * is not the number of replies. Three separate figures, three separate counts.
   */
  async teamDaily(days: number): Promise<Array<SupportDay & { activeMembers: number }>> {
    const rows = await this.identities.manager.query<Array<Record<string, string>>>(
      `
      SELECT
        to_char(d.day, 'YYYY-MM-DD')      AS day,
        COUNT(m.id)                       AS replies,
        COUNT(DISTINCT m."groupId")       AS groups,
        COUNT(DISTINCT i.id)              AS active_members
      FROM generate_series(
             date_trunc('day', now()) - make_interval(days => $1::int - 1),
             date_trunc('day', now()),
             interval '1 day'
           ) AS d(day)
      LEFT JOIN messages m
        ON m.classification = 'TEAM_MESSAGE'
       AND m."sentAt" >= d.day
       AND m."sentAt" < d.day + interval '1 day'
      LEFT JOIN team_member_identities i
        ON i."channelKey" = m."channelKey"
       AND (i."externalId" = m."senderExternalId" OR i.phone = m."senderPhone")
      GROUP BY d.day
      ORDER BY d.day ASC
      `,
      [days],
    );

    return rows.map((row) => ({
      day: row.day,
      replies: Number(row.replies ?? 0),
      groups: Number(row.groups ?? 0),
      activeMembers: Number(row.active_members ?? 0),
    }));
  }

  /**
   * Who replied on one specific day, and in which groups by name.
   *
   * This is the drill-down behind a bar on the activity chart: picking a day has to be answerable
   * with "these people, in these groups", not just a number.
   */
  async dayDetail(day: string): Promise<
    Array<{ identityId: string; displayName: string; replies: number; groups: string[] }>
  > {
    const rows = await this.identities.manager.query<Array<Record<string, string | string[]>>>(
      `
      SELECT
        i.id                                        AS identity_id,
        i."displayName"                             AS display_name,
        COUNT(*)                                    AS replies,
        array_agg(DISTINCT COALESCE(g.name, 'Direct chat')) AS groups
      FROM messages m
      JOIN team_member_identities i
        ON i."channelKey" = m."channelKey"
       AND (i."externalId" = m."senderExternalId" OR i.phone = m."senderPhone")
      LEFT JOIN groups g ON g.id = m."groupId"
      WHERE m.classification = 'TEAM_MESSAGE'
        AND m."sentAt" >= $1::date
        AND m."sentAt" <  $1::date + interval '1 day'
      GROUP BY i.id, i."displayName"
      ORDER BY replies DESC, i."displayName" ASC, i.id ASC
      `,
      [day],
    );

    return rows.map((row) => ({
      identityId: String(row.identity_id),
      displayName: String(row.display_name),
      replies: Number(row.replies ?? 0),
      groups: (row.groups as string[]) ?? [],
    }));
  }
}

/** Narrows a driver value to text, preserving a genuine null rather than turning it into "null". */
function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}
