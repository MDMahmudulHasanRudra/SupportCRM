import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Group } from './entities/group.entity';

/**
 * Everything the group detail screen needs, in one call.
 *
 * ## Why one endpoint rather than a request per tab
 *
 * The tabs describe one group. Issuing a request per tab means the screen makes six round trips to
 * answer six questions about the same row, and each of those repeats the same lookup. Here the
 * figures come from three statements that each scan the group's messages once, so adding a tab
 * costs a column rather than a query.
 *
 * ## Replies and groups, again
 *
 * Within a single group "unique groups" is meaningless, so what matters here is the *people*:
 * `uniqueSupportMembers` is a distinct count of identities, not of messages. Twelve messages from
 * one person is one person.
 *
 * ## Every figure is derived, none stored
 *
 * There is no counter column being incremented as messages arrive. A maintained counter drifts the
 * first time a write fails halfway and then disagrees, permanently and silently, with the rows it
 * claims to summarise. These count the rows themselves.
 */

export interface GroupStats {
  groupId: string;

  activity: {
    totalMessages: number;
    messagesToday: number;
    messagesThisWeek: number;
    messagesThisMonth: number;
    firstMessageAt: string | null;
    lastMessageAt: string | null;
  };

  ai: {
    replies: number;
    repliesToday: number;
    repliesThisMonth: number;
    lastReplyAt: string | null;
    /** Recorded decisions where the engine declined, by reason. Real rows, not inference. */
    blocks: Array<{ reasonCode: string; events: number; lastAt: string | null }>;
  };

  support: {
    messages: number;
    messagesToday: number;
    messagesThisMonth: number;
    /** Distinct registered support members who replied here — people, not messages. */
    uniqueMembers: number;
    lastSupportAt: string | null;
    members: Array<{ identityId: string; displayName: string; messages: number; lastAt: string | null }>;
  };

  patterns: {
    detected: number;
    pending: number;
    lastDetectedAt: string | null;
    items: Array<{ candidateId: string; title: string; occurrences: number; status: string; detectedAt: string }>;
  };
}

@Injectable()
export class GroupStatsService {
  constructor(@InjectRepository(Group) private readonly groups: Repository<Group>) {}

  async forGroup(groupId: string): Promise<GroupStats> {
    const group = await this.groups.findOne({ where: { id: groupId }, select: { id: true } });
    if (!group) throw new NotFoundException(`Group ${groupId} not found`);

    const [activity, blocks, members, patterns] = await Promise.all([
      this.activity(groupId),
      this.blocks(groupId),
      this.supportMembers(groupId),
      this.patterns(groupId),
    ]);

    return {
      groupId,
      activity: activity.activity,
      ai: { ...activity.ai, blocks },
      support: {
        ...activity.support,
        // Distinct identities, taken from the breakdown rather than counted again: twelve messages
        // from one person is one person, and deriving it here keeps the two consistent.
        uniqueMembers: members.length,
        members,
      },
      patterns,
    };
  }

  /**
   * Message, AI and support counters in one scan.
   *
   * All three tabs' headline numbers come from a single pass over this group's messages, with the
   * windows expressed as `FILTER` clauses. Three separate queries would scan the same rows three
   * times and could observe different data if a message landed between them.
   *
   * Every window is half-open. `>= midnight` alone counts messages dated in the future, which
   * WhatsApp produces whenever a sending device's clock runs ahead.
   */
  private async activity(groupId: string) {
    const [row] = await this.groups.manager.query<Array<Record<string, string | null>>>(
      `
      SELECT
        COUNT(*)                                                                      AS total_messages,
        COUNT(*) FILTER (WHERE m."sentAt" >= date_trunc('day', now())
                           AND m."sentAt" <  date_trunc('day', now()) + interval '1 day')     AS messages_today,
        COUNT(*) FILTER (WHERE m."sentAt" >= date_trunc('week', now())
                           AND m."sentAt" <  now())                                            AS messages_week,
        COUNT(*) FILTER (WHERE m."sentAt" >= date_trunc('month', now())
                           AND m."sentAt" <  now())                                            AS messages_month,
        MIN(m."sentAt")                                                               AS first_message_at,
        MAX(m."sentAt")                                                               AS last_message_at,

        COUNT(*) FILTER (WHERE m.classification = 'BOT_MESSAGE')                      AS ai_replies,
        COUNT(*) FILTER (WHERE m.classification = 'BOT_MESSAGE'
                           AND m."sentAt" >= date_trunc('day', now())
                           AND m."sentAt" <  date_trunc('day', now()) + interval '1 day')      AS ai_today,
        COUNT(*) FILTER (WHERE m.classification = 'BOT_MESSAGE'
                           AND m."sentAt" >= date_trunc('month', now())
                           AND m."sentAt" <  now())                                            AS ai_month,
        MAX(m."sentAt") FILTER (WHERE m.classification = 'BOT_MESSAGE')               AS ai_last_at,

        COUNT(*) FILTER (WHERE m.classification = 'TEAM_MESSAGE')                     AS support_messages,
        COUNT(*) FILTER (WHERE m.classification = 'TEAM_MESSAGE'
                           AND m."sentAt" >= date_trunc('day', now())
                           AND m."sentAt" <  date_trunc('day', now()) + interval '1 day')      AS support_today,
        COUNT(*) FILTER (WHERE m.classification = 'TEAM_MESSAGE'
                           AND m."sentAt" >= date_trunc('month', now())
                           AND m."sentAt" <  now())                                            AS support_month,
        MAX(m."sentAt") FILTER (WHERE m.classification = 'TEAM_MESSAGE')              AS support_last_at
      FROM messages m
      WHERE m."groupId" = $1
      `,
      [groupId],
    );

    return {
      activity: {
        totalMessages: Number(row.total_messages ?? 0),
        messagesToday: Number(row.messages_today ?? 0),
        messagesThisWeek: Number(row.messages_week ?? 0),
        messagesThisMonth: Number(row.messages_month ?? 0),
        firstMessageAt: row.first_message_at,
        lastMessageAt: row.last_message_at,
      },
      ai: {
        replies: Number(row.ai_replies ?? 0),
        repliesToday: Number(row.ai_today ?? 0),
        repliesThisMonth: Number(row.ai_month ?? 0),
        lastReplyAt: row.ai_last_at,
      },
      support: {
        messages: Number(row.support_messages ?? 0),
        messagesToday: Number(row.support_today ?? 0),
        messagesThisMonth: Number(row.support_month ?? 0),
        lastSupportAt: row.support_last_at,
      },
    };
  }

  /** Recorded reasons the engine declined to answer in this group. */
  private async blocks(groupId: string) {
    const rows = await this.groups.manager.query<Array<Record<string, string | null>>>(
      `
      SELECT d."reasonCode" AS reason_code, COUNT(*) AS events, MAX(d."createdAt") AS last_at
      FROM decision_logs d
      JOIN messages m ON m.id = d."messageId"
      WHERE m."groupId" = $1
        AND d."reasonCode" IN (
          'AI_DISABLED', 'AI_DISABLED_GROUP', 'AI_DISABLED_CONVERSATION', 'AI_DISABLED_PROFILE',
          'MONITORING_DISABLED', 'EMERGENCY_STOP', 'AI_UNAVAILABLE', 'LOOP_GUARD', 'RATE_LIMITED'
        )
      GROUP BY d."reasonCode"
      ORDER BY events DESC, d."reasonCode" ASC
      `,
      [groupId],
    );

    return rows.map((row) => ({
      reasonCode: String(row.reason_code),
      events: Number(row.events ?? 0),
      lastAt: row.last_at,
    }));
  }

  /**
   * Who supported this group, by name.
   *
   * Joined to `team_member_identities` on the stable identifiers — provider id or phone, never
   * display name, which changes whenever somebody edits their WhatsApp profile.
   */
  private async supportMembers(groupId: string) {
    const rows = await this.groups.manager.query<Array<Record<string, string | null>>>(
      `
      SELECT
        i.id            AS identity_id,
        i."displayName" AS display_name,
        COUNT(*)        AS messages,
        MAX(m."sentAt") AS last_at
      FROM messages m
      JOIN team_member_identities i
        ON i."channelKey" = m."channelKey"
       AND (i."externalId" = m."senderExternalId" OR i.phone = m."senderPhone")
      WHERE m."groupId" = $1 AND m.classification = 'TEAM_MESSAGE'
      GROUP BY i.id, i."displayName"
      ORDER BY messages DESC, i."displayName" ASC, i.id ASC
      `,
      [groupId],
    );

    return rows.map((row) => ({
      identityId: String(row.identity_id),
      displayName: String(row.display_name),
      messages: Number(row.messages ?? 0),
      lastAt: row.last_at,
    }));
  }

  /** Repeated-question candidates the detector attributed to this group. */
  private async patterns(groupId: string) {
    const rows = await this.groups.manager.query<Array<Record<string, string | null>>>(
      `
      SELECT id, title, occurrences, status, "createdAt" AS detected_at,
             COUNT(*)  OVER ()                                          AS total,
             COUNT(*) FILTER (WHERE status = 'PENDING') OVER ()         AS pending_total
      FROM automation_candidates
      WHERE "scopeId" = $1
      ORDER BY occurrences DESC, "createdAt" DESC, id ASC
      LIMIT 25
      `,
      [groupId],
    );

    const items = rows.map((row) => ({
      candidateId: String(row.id),
      title: String(row.title),
      occurrences: Number(row.occurrences ?? 0),
      status: String(row.status),
      detectedAt: String(row.detected_at),
    }));

    return {
      // The real totals, from window functions over the unlimited set — `items` is a capped page
      // and reporting its length as "detected" would silently understate past 25.
      detected: rows.length > 0 ? Number(rows[0].total ?? 0) : 0,
      pending: rows.length > 0 ? Number(rows[0].pending_total ?? 0) : 0,
      lastDetectedAt: items.length > 0 ? items[0].detectedAt : null,
      items,
    };
  }
}
