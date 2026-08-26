import { SupportAnalyticsService } from './support-analytics.service';

/**
 * Guards on the support-activity SQL.
 *
 * The invariant worth protecting is the one a reader cannot check by eye: **replies and groups are
 * counted with different expressions and are never substituted for one another**. "42 replies" and
 * "42 groups helped" are different claims, and the second is far stronger — a member who sent forty
 * messages in one group helped one group. Verified against real data: three replies in a single
 * group aggregate to `replies=3, groups=1`.
 *
 * These assert the emitted statement rather than results, because the failure mode is a plausible
 * query returning a plausible number that happens to describe something else.
 */

function service() {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params: unknown[]) => {
    queries.push({ sql, params });
    return [];
  });
  return { instance: new SupportAnalyticsService({ manager: { query } } as never), queries };
}

/** Collapses whitespace so assertions are not hostage to SQL indentation. */
const flat = (sql: string) => sql.replace(/\s+/g, ' ');

describe('support analytics SQL', () => {
  describe('replies and groups are counted differently', () => {
    it('counts replies with COUNT(*) and groups with COUNT(DISTINCT groupId)', async () => {
      const { instance, queries } = service();
      await instance.roster();
      const sql = flat(queries[0].sql);

      expect(sql).toContain('COUNT(*) FILTER');
      expect(sql).toContain('COUNT(DISTINCT m."groupId") FILTER');
      // Three windows of each, and never a bare COUNT(*) standing in for a group count.
      expect(sql.match(/COUNT\(DISTINCT m\."groupId"\) FILTER/g)).toHaveLength(3);
    });

    it('keeps the two apart in the per-day series as well', async () => {
      const { instance, queries } = service();
      await instance.memberDaily('id', 30);
      const sql = flat(queries[0].sql);

      expect(sql).toContain('COUNT(m.id) AS replies');
      expect(sql).toContain('COUNT(DISTINCT m."groupId") AS groups');
    });

    it('counts active members separately from replies and groups', async () => {
      // Three distinct figures: how many replies, how many groups, how many people. Collapsing any
      // two of them would report one number as another.
      const { instance, queries } = service();
      await instance.teamDaily(30);
      const sql = flat(queries[0].sql);

      expect(sql).toContain('COUNT(m.id) AS replies');
      expect(sql).toContain('COUNT(DISTINCT m."groupId") AS groups');
      expect(sql).toContain('COUNT(DISTINCT i.id) AS active_members');
    });
  });

  describe('only real support replies are counted', () => {
    it.each([
      ['roster', (s: SupportAnalyticsService) => s.roster()],
      ['memberDaily', (s: SupportAnalyticsService) => s.memberDaily('id', 30)],
      ['memberGroups', (s: SupportAnalyticsService) => s.memberGroups('id', 30)],
      ['teamDaily', (s: SupportAnalyticsService) => s.teamDaily(30)],
      ['dayDetail', (s: SupportAnalyticsService) => s.dayDetail('2026-01-01')],
    ])('%s counts only TEAM_MESSAGE', async (_name, run) => {
      // Not BOT_MESSAGE, and not UNKNOWN. Counting either would credit a person with the AI's work,
      // or with messages from senders nobody has identified.
      const { instance, queries } = service();
      await run(instance);

      expect(queries[0].sql).toContain("classification = 'TEAM_MESSAGE'");
      expect(queries[0].sql).not.toContain('BOT_MESSAGE');
    });

    it('matches a sender by provider id or by phone', async () => {
      // Both are needed: the JID is exact but changes shape for privacy-id senders, while the phone
      // survives that. Matching on only one silently loses a member's activity.
      const { instance, queries } = service();
      await instance.roster();

      expect(flat(queries[0].sql)).toContain(
        'AND (m."senderExternalId" = i."externalId" OR m."senderPhone" = i.phone)',
      );
    });
  });

  describe('absence is reported, not hidden', () => {
    it('keeps members who have never replied, with a LEFT JOIN', async () => {
      // An inner join would drop them, making "nobody has replied yet" indistinguishable from
      // "nobody is registered" — two problems with different fixes.
      const { instance, queries } = service();
      await instance.roster();

      expect(flat(queries[0].sql)).toContain('FROM team_member_identities i LEFT JOIN messages m');
    });

    it('emits a row for every day in the window, including empty ones', async () => {
      // A chart that omits quiet days draws a line straight through the gap, which reads as
      // activity that did not happen.
      const { instance, queries } = service();
      await instance.memberDaily('id', 30);

      expect(queries[0].sql).toContain('generate_series');
      expect(queries[0].params).toEqual(['id', 30]);
    });

    it('excludes inactive members by default and includes them on request', async () => {
      const off = service();
      await off.instance.roster();
      expect(off.queries[0].sql).toContain('WHERE i."isActive" = true');

      const on = service();
      await on.instance.roster({ includeInactive: true });
      expect(on.queries[0].sql).not.toContain('WHERE i."isActive" = true');
    });
  });

  describe('bounds and injection', () => {
    it('passes the window and the day as parameters, never as interpolated text', async () => {
      const { instance, queries } = service();
      await instance.dayDetail('2026-01-01');

      expect(queries[0].params).toEqual(['2026-01-01']);
      expect(queries[0].sql).not.toContain('2026-01-01');
    });

    it('names groups in the drill-down rather than only counting them', async () => {
      // "You helped 6 groups" is not reviewable; naming them is.
      const { instance, queries } = service();
      await instance.dayDetail('2026-01-01');

      expect(flat(queries[0].sql)).toContain("array_agg(DISTINCT COALESCE(g.name, 'Direct chat'))");
    });
  });

  describe('windows are bounded at both ends', () => {
    it('bounds "today" above as well as below', async () => {
      // `>= midnight` alone counts messages dated in the future. WhatsApp carries the sending
      // device's timestamp, so a skewed clock produces exactly those. Observed as a roster claiming
      // 23 replies today against 12 that actually happened today.
      const { instance, queries } = service();
      await instance.roster();
      const sql = flat(queries[0].sql);

      expect(sql).toContain(`m."sentAt" >= date_trunc('day', now()) AND m."sentAt" < date_trunc('day', now()) + interval '1 day'`);
    });

    it('bounds the rolling windows at now, not open-ended', async () => {
      const { instance, queries } = service();
      await instance.roster();
      const sql = flat(queries[0].sql);

      expect(sql).toContain(`m."sentAt" >= now() - interval '7 days' AND m."sentAt" <= now()`);
      expect(sql).toContain(`m."sentAt" >= now() - interval '30 days' AND m."sentAt" <= now()`);
    });
  });

  describe('day-by-day activity', () => {
    it('groups by day and by group, so a day can name its groups', async () => {
      const { instance, queries } = service();
      await instance.memberActivity('id', new Date('2026-08-01'), new Date('2026-08-31'));
      const sql = flat(queries[0].sql);

      expect(sql).toContain(`to_char(date_trunc('day', m."sentAt"), 'YYYY-MM-DD')`);
      expect(sql).toContain('GROUP BY 1, m."groupId"');
    });

    it('takes an explicit half-open range rather than computing one in SQL', async () => {
      const from = new Date('2026-08-01');
      const to = new Date('2026-08-31');
      const { instance, queries } = service();
      await instance.memberActivity('id', from, to);

      expect(queries[0].params).toEqual(['id', from, to]);
    });

    it('counts one row per group per day, so twenty messages in one group is one group', async () => {
      // The distinction the whole screen rests on.
      const rows = [
        { day: '2026-08-26', group_id: 'g1', group_name: 'A', messages: '20', first_at: null, last_at: null },
        { day: '2026-08-26', group_id: 'g2', group_name: 'B', messages: '3', first_at: null, last_at: null },
        { day: '2026-08-25', group_id: 'g1', group_name: 'A', messages: '5', first_at: null, last_at: null },
      ];
      const query = jest.fn(async () => rows);
      const instance = new SupportAnalyticsService({ manager: { query } } as never);

      const days = await instance.memberActivity('id', new Date(), new Date());

      expect(days).toHaveLength(2);
      expect(days[0]).toMatchObject({ day: '2026-08-26', groupCount: 2, totalMessages: 23 });
      expect(days[1]).toMatchObject({ day: '2026-08-25', groupCount: 1, totalMessages: 5 });
    });

    it('labels a message with no group rather than dropping it', async () => {
      const query = jest.fn(async () => [
        { day: '2026-08-26', group_id: null, group_name: null, messages: '2', first_at: null, last_at: null },
      ]);
      const instance = new SupportAnalyticsService({ manager: { query } } as never);

      const days = await instance.memberActivity('id', new Date(), new Date());
      expect(days[0].groups[0].groupName).toBe('Direct chat');
    });
  });
});
