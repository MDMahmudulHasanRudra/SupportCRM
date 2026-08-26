import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import { ConversationControlState } from '../crm/conversation-states';
import { Conversation } from '../crm/entities/conversation.entity';
import { DecisionLog } from '../decision/entities/decision-log.entity';
import { Escalation, EscalationStatus } from '../escalation/entities/escalation.entity';
import { Group, GroupMonitoringState } from '../groups/entities/group.entity';
import { DeliveryStatus } from '../messaging/message-types';
import { OutboundMessage } from '../messaging/entities/outbound-message.entity';
import { Broadcast } from '../broadcast/entities/broadcast.entity';
import { Job, JobStatus } from '../jobs/entities/job.entity';

/**
 * Every number the dashboard and the reports show (`PROJECT_SPEC.md` §100–§106).
 *
 * Two rules govern this whole file.
 *
 * **Counted from raw rows, at query time.** There is no aggregate table to drift out of step with
 * the events it summarises. A changed definition of "resolved" reinterprets history rather than
 * leaving two numbers that disagree and no way to tell which is right.
 *
 * **Never invented.** A figure that cannot be computed from what was actually recorded is returned
 * as null, not as zero. "We have no delivery receipts for this channel" and "nothing was delivered"
 * are different facts, and a dashboard that renders both as `0` is lying about one of them.
 */

export interface DateWindow {
  from: Date;
  to: Date;
}

/** The default window: the last seven days, ending now. */
export function defaultWindow(now = new Date()): DateWindow {
  const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { from, to: now };
}

@Injectable()
export class ReportsService {
  constructor(
    @InjectRepository(Conversation) private readonly conversations: Repository<Conversation>,
    @InjectRepository(OutboundMessage) private readonly outbound: Repository<OutboundMessage>,
    @InjectRepository(DecisionLog) private readonly decisions: Repository<DecisionLog>,
    @InjectRepository(Escalation) private readonly escalations: Repository<Escalation>,
    @InjectRepository(Group) private readonly groups: Repository<Group>,
    @InjectRepository(Job) private readonly jobs: Repository<Job>,
    @InjectRepository(Broadcast) private readonly broadcasts: Repository<Broadcast>,
  ) {}

  /**
   * The dashboard (§100, §101).
   *
   * One method rather than a dozen endpoints because the screen shows them together, and a dozen
   * round trips on page load is how a dashboard becomes something people avoid opening.
   */
  async dashboard(window: DateWindow) {
    const [conversationTotals, decisionTotals, escalationTotals, responseTimes, health] = await Promise.all([
      this.conversationTotals(window),
      this.decisionTotals(window),
      this.escalationTotals(window),
      this.responseTimes(window),
      this.systemHealth(),
    ]);

    return {
      window: { from: window.from.toISOString(), to: window.to.toISOString() },
      conversations: conversationTotals,
      decisions: decisionTotals,
      escalations: escalationTotals,
      timing: responseTimes,
      health,
    };
  }

  private async conversationTotals(window: DateWindow) {
    const rows = await this.conversations
      .createQueryBuilder('c')
      .select('c.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('c.createdAt BETWEEN :from AND :to', window)
      .groupBy('c.status')
      .getRawMany<{ status: string; count: string }>();

    const byStatus = Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
    const total = Object.values(byStatus).reduce((sum, value) => sum + value, 0);

    const humanHandled = await this.conversations.count({
      where: { createdAt: between(window), controlState: ConversationControlState.HUMAN_ACTIVE },
    });

    return { total, byStatus, humanHandled };
  }

  private async decisionTotals(window: DateWindow) {
    const rows = await this.decisions
      .createQueryBuilder('d')
      .select('d.outcome', 'outcome')
      .addSelect('COUNT(*)', 'count')
      .where('d.createdAt BETWEEN :from AND :to', window)
      .groupBy('d.outcome')
      .getRawMany<{ outcome: string | null; count: string }>();

    const byOutcome = Object.fromEntries(rows.map((row) => [row.outcome ?? 'IN_PROGRESS', Number(row.count)]));
    const total = Object.values(byOutcome).reduce((sum, value) => sum + value, 0);

    const answered = (byOutcome.RULE_REPLY ?? 0) + (byOutcome.AI_REPLY ?? 0);

    return {
      total,
      byOutcome,
      answeredAutomatically: answered,
      // A rate over zero decisions is not zero per cent, it is undefined. Rendering it as 0%
      // would tell an operator the automation is failing when nothing has happened yet.
      automationRate: total > 0 ? Number((answered / total).toFixed(3)) : null,
    };
  }

  private async escalationTotals(window: DateWindow) {
    const rows = await this.escalations
      .createQueryBuilder('e')
      .select('e.reason', 'reason')
      .addSelect('COUNT(*)', 'count')
      .where('e.createdAt BETWEEN :from AND :to', window)
      .groupBy('e.reason')
      .getRawMany<{ reason: string; count: string }>();

    const open = await this.escalations.count({ where: { status: EscalationStatus.OPEN } });

    return {
      total: rows.reduce((sum, row) => sum + Number(row.count), 0),
      byReason: Object.fromEntries(rows.map((row) => [row.reason, Number(row.count)])),
      openNow: open,
    };
  }

  /**
   * First response and resolution times (§100).
   *
   * Computed in SQL from the rows themselves. Conversations with no response yet are excluded from
   * the average rather than counted as zero — an unanswered conversation is not a fast one.
   */
  private async responseTimes(window: DateWindow) {
    const firstResponse = await this.conversations.manager.query<Array<{ avg_seconds: string | null }>>(
      `
      SELECT AVG(EXTRACT(EPOCH FROM (first_out.sent_at - c."createdAt"))) AS avg_seconds
      FROM conversations c
      JOIN LATERAL (
        SELECT MIN(m."sentAt") AS sent_at
        FROM messages m
        WHERE m."conversationId" = c.id AND m.direction = 'OUTBOUND'
      ) first_out ON TRUE
      WHERE c."createdAt" BETWEEN $1 AND $2 AND first_out.sent_at IS NOT NULL
      `,
      [window.from, window.to],
    );

    const resolution = await this.conversations.manager.query<Array<{ avg_seconds: string | null }>>(
      `
      SELECT AVG(EXTRACT(EPOCH FROM (c."updatedAt" - c."createdAt"))) AS avg_seconds
      FROM conversations c
      WHERE c."createdAt" BETWEEN $1 AND $2 AND c.status IN ('RESOLVED', 'CLOSED')
      `,
      [window.from, window.to],
    );

    const seconds = (value: string | null | undefined) =>
      value === null || value === undefined ? null : Math.round(Number(value));

    return {
      firstResponseSeconds: seconds(firstResponse[0]?.avg_seconds),
      resolutionSeconds: seconds(resolution[0]?.avg_seconds),
    };
  }

  private async systemHealth() {
    const [monitoredGroups, failedJobs, failedOutbound] = await Promise.all([
      this.groups.count({ where: { monitoringState: GroupMonitoringState.MONITORED, isActive: true } }),
      this.jobs.count({ where: { status: JobStatus.FAILED } }),
      this.outbound.count({ where: { status: DeliveryStatus.FAILED } }),
    ]);

    return { monitoredGroups, failedJobs, failedOutbound };
  }

  /**
   * Daily activity, for the dashboard's trend chart (§100).
   *
   * Counted per day from the same raw rows the totals come from, so the chart and the figures above
   * it can never disagree. `generate_series` fills days that have no rows: a day with nothing on it
   * genuinely had nothing, and leaving it out would draw a continuous line between two dates that
   * were not adjacent — which reads as activity that did not happen.
   *
   * Three scalar subqueries rather than three joins on purpose: joining them per day multiplies the
   * rows against each other and inflates every count.
   */
  async activityTrend(window: DateWindow) {
    const rows = await this.conversations.manager.query<
      Array<{ day: string; conversations: string; automated: string; escalations: string }>
    >(
      `
      WITH days AS (
        SELECT generate_series($1::date, $2::date, interval '1 day')::date AS day
      )
      SELECT
        days.day AS day,
        (SELECT COUNT(*) FROM conversations c WHERE c."createdAt"::date = days.day) AS conversations,
        (SELECT COUNT(*) FROM decision_logs d
           WHERE d."createdAt"::date = days.day AND d.outcome IN ('RULE_REPLY', 'AI_REPLY')) AS automated,
        (SELECT COUNT(*) FROM escalations e WHERE e."createdAt"::date = days.day) AS escalations
      FROM days
      ORDER BY days.day
      `,
      [window.from, window.to],
    );

    return {
      items: rows.map((row) => ({
        day: row.day,
        conversations: Number(row.conversations),
        automated: Number(row.automated),
        escalations: Number(row.escalations),
      })),
    };
  }

  /**
   * Team performance (§69).
   *
   * Explicitly **not** message count. Counting messages rewards the agent who sends five short
   * replies over the one who solved it in two, and every support team learns to game it within a
   * month. These are the measures the spec names instead.
   */
  async teamPerformance(window: DateWindow) {
    const rows = await this.conversations.manager.query<
      Array<{
        user_id: string | null;
        name: string | null;
        conversations: string;
        resolved: string;
        groups: string;
        customers: string;
        active_days: string;
      }>
    >(
      `
      SELECT
        c."assignedToUserId"                             AS user_id,
        u.name                                           AS name,
        COUNT(DISTINCT c.id)                             AS conversations,
        COUNT(DISTINCT c.id) FILTER (WHERE c.status IN ('RESOLVED','CLOSED')) AS resolved,
        COUNT(DISTINCT c."groupId")                      AS groups,
        COUNT(DISTINCT c."customerId")                   AS customers,
        COUNT(DISTINCT DATE(c."updatedAt"))              AS active_days
      FROM conversations c
      LEFT JOIN users u ON u.id = c."assignedToUserId"
      WHERE c."assignedToUserId" IS NOT NULL
        AND c."createdAt" BETWEEN $1 AND $2
      GROUP BY c."assignedToUserId", u.name
      ORDER BY conversations DESC
      `,
      [window.from, window.to],
    );

    return {
      items: rows.map((row) => ({
        userId: row.user_id,
        name: row.name,
        conversations: Number(row.conversations),
        resolved: Number(row.resolved),
        groupsSupported: Number(row.groups),
        uniqueCustomers: Number(row.customers),
        activeDays: Number(row.active_days),
      })),
    };
  }

  /**
   * What customers actually ask about (§101, §106).
   *
   * Grouped by the decision's reason rather than by guessing at message text: a reason code is
   * something the system recorded, and a topic model over customer messages would be an invention.
   */
  async topIssues(window: DateWindow, limit = 20) {
    const rows = await this.decisions
      .createQueryBuilder('d')
      .select('d.reasonCode', 'reason')
      .addSelect('COUNT(*)', 'count')
      .where('d.createdAt BETWEEN :from AND :to', window)
      .andWhere('d.reasonCode IS NOT NULL')
      .groupBy('d.reasonCode')
      .orderBy('count', 'DESC')
      .limit(limit)
      .getRawMany<{ reason: string; count: string }>();

    return { items: rows.map((row) => ({ reason: row.reason, count: Number(row.count) })) };
  }

  /** Where the knowledge base is failing customers (§75). */
  async knowledgeGaps(window: DateWindow, limit = 20) {
    const rows = await this.escalations
      .createQueryBuilder('e')
      .select('e.detail', 'detail')
      .addSelect('COUNT(*)', 'count')
      .where('e.createdAt BETWEEN :from AND :to', window)
      .andWhere('e.reason = :reason', { reason: 'KNOWLEDGE_INSUFFICIENT' })
      .groupBy('e.detail')
      .orderBy('count', 'DESC')
      .limit(limit)
      .getRawMany<{ detail: string | null; count: string }>();

    return { items: rows.map((row) => ({ detail: row.detail, count: Number(row.count) })) };
  }

  /**
   * Campaign outcomes (§104, §195).
   *
   * Counted from the recipient rows, not from the broadcast's own counters — the counters are a
   * running total the worker maintains, and a report that disagrees with the rows it summarises is
   * the thing this whole file avoids.
   */
  async broadcastReport(window: DateWindow) {
    const rows = await this.broadcasts.manager.query<
      Array<{
        id: string;
        name: string;
        status: string;
        started_at: Date | null;
        sent: string;
        failed: string;
        skipped: string;
        total: string;
      }>
    >(
      `
      SELECT
        b.id, b.name, b.status, b."startedAt" AS started_at,
        COUNT(r.*) FILTER (WHERE r.status IN ('SENT','DELIVERED')) AS sent,
        COUNT(r.*) FILTER (WHERE r.status = 'FAILED')             AS failed,
        COUNT(r.*) FILTER (WHERE r.status = 'SKIPPED')            AS skipped,
        COUNT(r.*)                                                AS total
      FROM broadcasts b
      LEFT JOIN broadcast_recipients r ON r."broadcastId" = b.id
      WHERE b."createdAt" BETWEEN $1 AND $2
      GROUP BY b.id, b.name, b.status, b."startedAt"
      ORDER BY b."createdAt" DESC
      `,
      [window.from, window.to],
    );

    return {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        startedAt: row.started_at,
        total: Number(row.total),
        sent: Number(row.sent),
        failed: Number(row.failed),
        skipped: Number(row.skipped),
        // Undefined rather than 0% for a campaign with no recipients yet.
        successRate: Number(row.total) > 0 ? Number((Number(row.sent) / Number(row.total)).toFixed(3)) : null,
      })),
    };
  }

  /**
   * AI performance (§104).
   *
   * Deliberately reports the *outcomes*, not an accuracy score. There is no ground truth for
   * "was that answer correct" beyond what humans told us, so the human verdicts are shown as what
   * they are: a sample, not a measurement.
   */
  async aiPerformance(window: DateWindow) {
    const rows = await this.decisions
      .createQueryBuilder('d')
      .select('d.outcome', 'outcome')
      .addSelect('COUNT(*)', 'count')
      .addSelect('AVG(d."processingTimeMs")', 'avg_ms')
      .where('d.createdAt BETWEEN :from AND :to', window)
      .andWhere('d.aiProvider IS NOT NULL')
      .groupBy('d.outcome')
      .getRawMany<{ outcome: string | null; count: string; avg_ms: string | null }>();

    const feedback = await this.decisions.manager.query<Array<{ verdict: string; count: string }>>(
      `
      SELECT verdict, COUNT(*) AS count
      FROM ai_feedback
      WHERE "createdAt" BETWEEN $1 AND $2
      GROUP BY verdict
      `,
      [window.from, window.to],
    );

    return {
      byOutcome: Object.fromEntries(
        rows.map((row) => [
          row.outcome ?? 'IN_PROGRESS',
          { count: Number(row.count), averageMs: row.avg_ms === null ? null : Math.round(Number(row.avg_ms)) },
        ]),
      ),
      humanVerdicts: Object.fromEntries(feedback.map((row) => [row.verdict, Number(row.count)])),
      note: 'Human verdicts are a sample of what agents reviewed, not a measured accuracy rate.',
    };
  }

  /**
   * A report as rows, for export.
   *
   * Returns plain objects; the controller turns them into CSV. Streaming rather than an in-memory
   * array is the next step if these grow — the take() cap is there so a year-long export cannot
   * exhaust the process while that remains untrue.
   */
  async exportRows(report: 'conversations' | 'decisions' | 'escalations', window: DateWindow, limit = 10_000) {
    switch (report) {
      case 'conversations':
        return this.conversations.find({
          where: { createdAt: between(window) },
          order: { createdAt: 'DESC' },
          take: limit,
        });
      case 'decisions':
        return this.decisions.find({
          where: { createdAt: between(window) },
          order: { createdAt: 'DESC' },
          take: limit,
        });
      case 'escalations':
        return this.escalations.find({
          where: { createdAt: between(window) },
          order: { createdAt: 'DESC' },
          take: limit,
        });
    }
  }
}

/**
 * The window as a TypeORM operator.
 *
 * A helper rather than an inline `Between` at each call site, because the first version of this
 * returned a plain `{from, to}` object — which type-checks behind a cast and quietly matches
 * nothing. One place to get it right.
 */
function between(window: DateWindow) {
  return Between(window.from, window.to);
}
