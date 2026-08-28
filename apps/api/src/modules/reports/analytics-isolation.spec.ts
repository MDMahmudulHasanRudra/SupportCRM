import { ActivityAnalyticsService } from './activity-analytics.service';
import { GroupAiStatusService } from '../groups/group-ai-status.service';
import { GroupMonitoringState } from '../groups/entities/group.entity';

/**
 * Two properties the analytics rest on that no single query makes obvious.
 *
 * **Direct chats are not groups.** A one-to-one conversation has no group row, so its messages carry
 * a null `groupId`. Every "unique groups" figure is a `COUNT(DISTINCT "groupId")`, which ignores
 * nulls — that is what keeps private chats out of group coverage without a separate clause. A reply
 * sent in a direct chat is still a reply, and is still counted as one; it is simply not a group.
 *
 * **Accounts do not merge.** Groups are unique per `(channelAccountId, externalId)`, so the same
 * WhatsApp group synced under two accounts is two rows with two ids. Distinct counting therefore
 * cannot conflate them however the JIDs collide, and scoping to an account is a choice of view
 * rather than a correctness fix.
 *
 * Both are asserted against the emitted SQL, because both are properties of *how* the counting is
 * expressed. A fixture would pass just as happily against a query that had quietly started counting
 * rows instead of groups.
 */

function analytics() {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params: unknown[]) => {
    queries.push({ sql, params });
    return [];
  });
  return { instance: new ActivityAnalyticsService({ manager: { query } } as never), queries };
}

const flat = (sql: string) => sql.replace(/\s+/g, ' ');

describe('analytics isolation', () => {
  describe('direct chats are excluded from group figures', () => {
    it('counts unique groups with a DISTINCT over groupId, which skips nulls', async () => {
      const { instance, queries } = analytics();
      await instance.aiActivity({ bucket: 'day', periods: 7 });

      expect(flat(queries[0].sql)).toContain('COUNT(DISTINCT m."groupId") AS unique_groups');
    });

    it('still counts a direct-chat reply as a reply', async () => {
      // Replies are COUNT(*) over the classification — a reply in a direct chat is one. Only the
      // *group* column excludes it. Conflating the two would either lose real replies or invent
      // groups that do not exist.
      const { instance, queries } = analytics();
      await instance.aiActivity({ bucket: 'day', periods: 7 });
      const sql = flat(queries[0].sql);

      expect(sql).toContain('COUNT(m.id) AS messages');
      expect(sql).not.toContain('m."groupId" IS NOT NULL AND m.classification');
    });

    it('applies the same rule to human support', async () => {
      const { instance, queries } = analytics();
      await instance.supportActivity({ bucket: 'day', periods: 7 });

      expect(flat(queries[0].sql)).toContain('COUNT(DISTINCT m."groupId") AS unique_groups');
    });
  });

  describe('accounts stay isolated', () => {
    it('binds an account filter as a parameter rather than interpolating it', async () => {
      const { instance, queries } = analytics();
      await instance.aiActivity({ bucket: 'day', periods: 7, channelAccountId: 'acc-1' });

      expect(queries[0].sql).toContain('m."channelAccountId" = $');
      expect(queries[0].params).toContain('acc-1');
      // Never concatenated in.
      expect(queries[0].sql).not.toContain('acc-1');
    });

    it('omits the account clause entirely when scoping the whole estate', async () => {
      const { instance, queries } = analytics();
      await instance.aiActivity({ bucket: 'day', periods: 7 });

      expect(queries[0].sql).not.toContain('channelAccountId');
    });

    it('keeps the full run of buckets for an account with no activity', async () => {
      // The filter sits in the join, not the WHERE, so a quiet account still gets zeros for every
      // day rather than an empty series that renders as "no data".
      const { instance, queries } = analytics();
      await instance.aiActivity({ bucket: 'day', periods: 7, channelAccountId: 'acc-1' });
      const sql = flat(queries[0].sql);

      const joinStart = sql.indexOf('LEFT JOIN messages m');
      expect(joinStart).toBeGreaterThan(-1);
      expect(sql.slice(joinStart)).toContain('m."channelAccountId" = $');
    });

    it('scopes the block breakdown by account too', async () => {
      const { instance, queries } = analytics();
      await instance.aiBlocks({ from: new Date(), to: new Date(), channelAccountId: 'acc-1' });

      expect(queries[0].sql).toContain('d."channelAccountId" = $');
      expect(queries[0].params).toContain('acc-1');
    });
  });

  describe('SQL fragments are whitelisted, not trusted', () => {
    it('refuses an unexpected bucket rather than interpolating it', async () => {
      const { instance, queries } = analytics();
      // A caller reaching this with a query-string value would otherwise be writing SQL.
      await instance.aiActivity({ bucket: "day'); DROP TABLE messages; --" as never, periods: 7 });

      expect(queries[0].sql).not.toContain('DROP TABLE');
      expect(queries[0].sql).toContain("date_trunc('day'");
    });

    it('bounds how far back one request can reach', async () => {
      const { instance, queries } = analytics();
      await instance.aiActivity({ bucket: 'day', periods: 100_000 });

      expect(queries[0].params[0]).toBe(365);
    });
  });
});

/**
 * An absent signal is not a negative one.
 *
 * Two defaults matter here and both point the same way: a group that does not exist is not reported
 * as "AI disabled", and an emergency stop nobody has ever set is not reported as engaged. Reading
 * absence as denial would make the console claim AI is blocked when it is not — which sends an
 * operator hunting a switch that was never thrown.
 */
describe('unknown state is not read as blocked', () => {
  function statusService(options: { stopValue?: boolean | undefined; group?: Record<string, unknown> }) {
    const group = {
      id: 'g1',
      channelAccountId: 'a1',
      aiEnabled: true,
      automationEnabled: true,
      patternAnalysisEnabled: true,
      monitoringState: GroupMonitoringState.MONITORED,
      automationProfileId: null,
      knowledgeProfileId: null,
      ...options.group,
    };

    return new GroupAiStatusService(
      { findOne: jest.fn(async () => group) } as never,
      { findOne: jest.fn(async () => null) } as never,
      { findOne: jest.fn(async () => ({ status: 'CONNECTED' })) } as never,
      // `isStopped` resolves a setting that may never have been written. The service under test must
      // treat that as "not stopped".
      { isStopped: jest.fn(async () => options.stopValue ?? false) } as never,
    );
  }

  it('treats an emergency stop that was never set as not engaged', async () => {
    const status = await statusService({ stopValue: undefined }).forGroup('g1');

    expect(status.system.aiPaused).toBe(false);
    expect(status.blockedBy).not.toContain('EMERGENCY_STOP');
    expect(status.canReply).toBe(true);
  });

  it('reports a group with no automation profile as not-applicable, not blocked', async () => {
    // A missing profile has granted nothing and withheld nothing. Showing it as a green tick would
    // claim a check passed that never ran; showing it as blocking would be simply wrong.
    const status = await statusService({}).forGroup('g1');

    expect(status.profile).toBeNull();
    expect(status.blockedBy).not.toContain('AI_DISABLED_PROFILE');
  });
});
