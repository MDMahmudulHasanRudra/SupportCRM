import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Group } from '../groups/entities/group.entity';

/**
 * AI and human support activity over time, plus what the pattern detector has found.
 *
 * ## Messages and groups are counted separately, always
 *
 * If AI sends twenty replies into one group, that is **twenty replies and one group**. The two are
 * `COUNT(*)` and `COUNT(DISTINCT "groupId")` and are never substituted for one another, because
 * reporting twenty replies as twenty groups would overstate reach twentyfold.
 *
 * `COUNT(DISTINCT "groupId")` also ignores nulls, which is what keeps direct one-to-one chats out
 * of every group figure without a separate clause. A reply sent in a direct conversation still
 * counts as a reply — it is a reply — but it is not a group, and the two columns say so.
 *
 * ## Account scoping is optional and never implicit
 *
 * Groups are unique per `(channelAccountId, externalId)`, so the same WhatsApp group synced under
 * two accounts is two rows with two ids and can never be merged by a distinct count. Scoping is
 * therefore about *choosing* a view rather than about correctness: pass an account to see one
 * account's figures, omit it to see the estate.
 *
 * ## Buckets are the operator's days
 *
 * `date_trunc` runs on a session pinned to the application timezone, so a "day" here is the same
 * day the rest of the product means. Windows are half-open — `>= start AND < end` — because an
 * open-ended upper bound counts messages dated in the future, which WhatsApp produces whenever a
 * sending device's clock runs ahead.
 */

export interface ActivityPoint {
  /** `YYYY-MM-DD` for daily buckets, `YYYY-MM` for monthly. */
  bucket: string;
  messages: number;
  /** Distinct groups reached. Never equal to `messages` by construction. */
  uniqueGroups: number;
  conversations: number;
}

export interface SupportPoint extends ActivityPoint {
  /** Distinct registered support members who sent something in the bucket. */
  activeMembers: number;
}

export interface AiBlockRow {
  reasonCode: string;
  outcome: string;
  events: number;
  uniqueGroups: number;
  lastAt: string | null;
}

export interface PatternRow {
  candidateId: string;
  title: string;
  occurrences: number;
  status: string;
  scopeType: string | null;
  groupId: string | null;
  groupName: string | null;
  detectedAt: string;
}

type Bucket = 'day' | 'month';

@Injectable()
export class ActivityAnalyticsService {
  constructor(@InjectRepository(Group) private readonly groups: Repository<Group>) {}

  /**
   * AI reply volume per bucket.
   *
   * `generate_series` supplies the buckets so a quiet day returns a zero rather than being missing
   * — a chart that omits empty buckets draws a straight line through the gap and makes an absence
   * look like activity.
   */
  aiActivity(options: { bucket: Bucket; periods: number; channelAccountId?: string }): Promise<ActivityPoint[]> {
    return this.activity({ ...options, classification: 'BOT_MESSAGE' }) as Promise<ActivityPoint[]>;
  }

  /** Human support volume per bucket, plus how many people were active in each. */
  async supportActivity(options: {
    bucket: Bucket;
    periods: number;
    channelAccountId?: string;
  }): Promise<SupportPoint[]> {
    return (await this.activity({
      ...options,
      classification: 'TEAM_MESSAGE',
      countMembers: true,
    })) as SupportPoint[];
  }

  /**
   * The shared shape behind both series.
   *
   * One implementation rather than two near-identical queries: the only differences are which
   * classification is counted and whether distinct support members are counted alongside, and two
   * copies would drift the first time a bucket definition changed in one of them.
   */
  private async activity(options: {
    bucket: Bucket;
    periods: number;
    classification: 'BOT_MESSAGE' | 'TEAM_MESSAGE';
    channelAccountId?: string;
    countMembers?: boolean;
  }): Promise<ActivityPoint[] | SupportPoint[]> {
    /*
     * `bucket` and `classification` are interpolated into the statement, so they are re-checked
     * against a whitelist here rather than trusted from the type signature. Types vanish at
     * runtime; a caller reaching this with a string from a query parameter would otherwise be
     * writing SQL. Everything else is a bound parameter.
     */
    const bucket = options.bucket === 'month' ? 'month' : 'day';
    const classification = options.classification === 'TEAM_MESSAGE' ? 'TEAM_MESSAGE' : 'BOT_MESSAGE';
    const periods = Math.min(Math.max(options.periods, 1), bucket === 'day' ? 365 : 36);
    const format = bucket === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM';
    const step = bucket === 'day' ? "interval '1 day'" : "interval '1 month'";

    const params: unknown[] = [periods];
    // The account filter is a bound parameter applied inside the join, so an account with no
    // activity still gets its full run of zero buckets rather than an empty series.
    let accountClause = '';
    if (options.channelAccountId) {
      params.push(options.channelAccountId);
      accountClause = `AND m."channelAccountId" = $${params.length}`;
    }

    const memberSelect = options.countMembers
      ? `, COUNT(DISTINCT i.id) AS active_members`
      : '';
    const memberJoin = options.countMembers
      ? `LEFT JOIN team_member_identities i
           ON i."channelKey" = m."channelKey"
          AND (i."externalId" = m."senderExternalId" OR i.phone = m."senderPhone")`
      : '';

    const rows = await this.groups.manager.query<Array<Record<string, string>>>(
      `
      SELECT
        to_char(b.bucket, '${format}')          AS bucket,
        COUNT(m.id)                             AS messages,
        COUNT(DISTINCT m."groupId")             AS unique_groups,
        COUNT(DISTINCT m."conversationId")      AS conversations
        ${memberSelect}
      FROM generate_series(
             date_trunc('${bucket}', now()) - ($1::int - 1) * ${step},
             date_trunc('${bucket}', now()),
             ${step}
           ) AS b(bucket)
      LEFT JOIN messages m
        ON m."sentAt" >= b.bucket
       AND m."sentAt" <  b.bucket + ${step}
       AND m.classification = '${classification}'
       ${accountClause}
      ${memberJoin}
      GROUP BY b.bucket
      ORDER BY b.bucket ASC
      `,
      params,
    );

    return rows.map((row) => ({
      bucket: row.bucket,
      messages: Number(row.messages ?? 0),
      uniqueGroups: Number(row.unique_groups ?? 0),
      conversations: Number(row.conversations ?? 0),
      ...(options.countMembers ? { activeMembers: Number(row.active_members ?? 0) } : {}),
    })) as ActivityPoint[] | SupportPoint[];
  }

  /**
   * Times the engine decided not to let AI answer, by reason.
   *
   * These are real recorded decisions, not inferred: the engine writes a `decision_logs` row with a
   * reason code every time it declines. That makes "AI was blocked 40 times because the group has
   * it switched off" a fact with a row behind it rather than an estimate.
   *
   * Rows written before per-layer reason codes existed carry the general `AI_DISABLED`, so a total
   * for "AI was off" should include it alongside the specific codes.
   */
  async aiBlocks(options: {
    from: Date;
    to: Date;
    channelAccountId?: string;
  }): Promise<AiBlockRow[]> {
    const params: unknown[] = [options.from, options.to];
    let accountClause = '';
    if (options.channelAccountId) {
      params.push(options.channelAccountId);
      accountClause = `AND d."channelAccountId" = $${params.length}`;
    }

    const rows = await this.groups.manager.query<Array<Record<string, string | null>>>(
      `
      SELECT
        d."reasonCode"                  AS reason_code,
        d.outcome                       AS outcome,
        COUNT(*)                        AS events,
        COUNT(DISTINCT m."groupId")     AS unique_groups,
        MAX(d."createdAt")              AS last_at
      FROM decision_logs d
      LEFT JOIN messages m ON m.id = d."messageId"
      WHERE d."createdAt" >= $1 AND d."createdAt" < $2
        AND d."reasonCode" IN (
          'AI_DISABLED', 'AI_DISABLED_GROUP', 'AI_DISABLED_CONVERSATION', 'AI_DISABLED_PROFILE',
          'MONITORING_DISABLED', 'EMERGENCY_STOP', 'AI_UNAVAILABLE', 'LOOP_GUARD', 'RATE_LIMITED'
        )
        ${accountClause}
      GROUP BY d."reasonCode", d.outcome
      ORDER BY events DESC, d."reasonCode" ASC
      `,
      params,
    );

    return rows.map((row) => ({
      reasonCode: String(row.reason_code),
      outcome: String(row.outcome),
      events: Number(row.events ?? 0),
      uniqueGroups: Number(row.unique_groups ?? 0),
      lastAt: row.last_at,
    }));
  }

  /**
   * What the repeated-question detector has actually found.
   *
   * Reads `automation_candidates` — the rows the detector writes — rather than re-deriving patterns
   * on the fly. Every figure an operator sees here therefore corresponds to a candidate they can
   * open, with its evidence attached.
   *
   * `scopeId` is joined to `groups` so a pattern can name the group it came from; a globally-scoped
   * candidate has no group and says so rather than being dropped.
   */
  async patterns(options: { limit?: number; channelAccountId?: string } = {}): Promise<PatternRow[]> {
    const limit = Math.min(options.limit ?? 50, 200);
    const params: unknown[] = [limit];
    let accountClause = '';
    if (options.channelAccountId) {
      params.push(options.channelAccountId);
      accountClause = `AND (g.id IS NULL OR g."channelAccountId" = $${params.length})`;
    }

    const rows = await this.groups.manager.query<Array<Record<string, string | null>>>(
      `
      SELECT
        c.id            AS candidate_id,
        c.title         AS title,
        c.occurrences   AS occurrences,
        c.status        AS status,
        c."scopeType"   AS scope_type,
        g.id            AS group_id,
        g.name          AS group_name,
        c."createdAt"   AS detected_at
      FROM automation_candidates c
      LEFT JOIN groups g ON g.id = c."scopeId"
      WHERE 1 = 1 ${accountClause}
      ORDER BY c.occurrences DESC, c."createdAt" DESC, c.id ASC
      LIMIT $1
      `,
      params,
    );

    return rows.map((row) => ({
      candidateId: String(row.candidate_id),
      title: String(row.title),
      occurrences: Number(row.occurrences ?? 0),
      status: String(row.status),
      scopeType: row.scope_type,
      groupId: row.group_id,
      groupName: row.group_name,
      detectedAt: String(row.detected_at),
    }));
  }

  /**
   * A summary of pattern detection, for a header.
   *
   * Counts candidates and the groups they came from, and states how many groups are actually
   * feeding the detector — because "0 patterns" means something very different when no group has
   * pattern analysis switched on.
   */
  async patternSummary(): Promise<{
    total: number;
    pending: number;
    published: number;
    rejected: number;
    groupsWithPatterns: number;
    groupsContributing: number;
    lastDetectedAt: string | null;
  }> {
    const [row] = await this.groups.manager.query<Array<Record<string, string | null>>>(`
      SELECT
        (SELECT COUNT(*) FROM automation_candidates)                                     AS total,
        (SELECT COUNT(*) FROM automation_candidates WHERE status = 'PENDING')            AS pending,
        (SELECT COUNT(*) FROM automation_candidates WHERE status = 'PUBLISHED')          AS published,
        (SELECT COUNT(*) FROM automation_candidates WHERE status = 'REJECTED')           AS rejected,
        (SELECT COUNT(DISTINCT "scopeId") FROM automation_candidates
          WHERE "scopeId" IS NOT NULL)                                                   AS groups_with_patterns,
        (SELECT COUNT(*) FROM groups WHERE "patternAnalysisEnabled" = true)              AS groups_contributing,
        (SELECT MAX("createdAt") FROM automation_candidates)                             AS last_detected_at
    `);

    return {
      total: Number(row.total ?? 0),
      pending: Number(row.pending ?? 0),
      published: Number(row.published ?? 0),
      rejected: Number(row.rejected ?? 0),
      groupsWithPatterns: Number(row.groups_with_patterns ?? 0),
      groupsContributing: Number(row.groups_contributing ?? 0),
      lastDetectedAt: row.last_detected_at,
    };
  }
}
