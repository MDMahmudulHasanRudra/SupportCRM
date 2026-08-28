import { GroupOperationsService } from './group-operations.service';
import type { GroupSort } from './group-operations.service';

/**
 * Guards on the SQL the operations screen emits.
 *
 * These assert the shape of the statement rather than its results, because the properties that
 * matter here are ones a small fixture database would not exercise: a stable total order under
 * ties, and one WHERE builder shared by the list and by "select all matching".
 */

const SORTS: GroupSort[] = [
  'name',
  'members',
  'lastActivity',
  'messagesToday',
  'aiRepliesToday',
  'humanSupportToday',
];

/** The service over a stubbed repository, capturing every statement it runs. */
function service() {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params: unknown[]) => {
    queries.push({ sql, params });
    // `list` reads a count out of its second statement; everything else tolerates an empty set.
    return sql.includes('COUNT(*) AS count') ? [{ count: '0' }] : [];
  });

  const instance = new GroupOperationsService({ manager: { query } } as never);
  return { instance, queries };
}

describe('group operations SQL', () => {
  describe('ordering is total', () => {
    // The bug this pins: two groups genuinely both named "Eye Spy" made one appear on page 1 *and*
    // page 2 while a third group became unreachable. Postgres may order rows that tie on the sort
    // key however it likes, and differently per query, so LIMIT/OFFSET needs a unique final key.
    it.each(SORTS)('breaks ties on a unique column when sorting by %s', async (sort) => {
      const { instance, queries } = service();
      await instance.list({}, { limit: 25, offset: 0, sort, direction: 'ASC' });

      const order = queries[0].sql.slice(queries[0].sql.lastIndexOf('ORDER BY'));
      expect(order).toContain('g."id"');
      // Specifically *last* — a unique key anywhere earlier would make the rest of the clause dead.
      expect(order.slice(order.indexOf('g."id"'))).not.toMatch(/,/);
    });

    it('orders the select-all-matching resolution the same way', async () => {
      // This one is capped. Without a total order, *which* groups fall outside the cap would vary
      // between two identical requests.
      const { instance, queries } = service();
      await instance.idsMatching({}, 10_000);

      expect(queries[0].sql).toContain('ORDER BY g."name" ASC, g."id" ASC');
    });
  });

  describe('filters', () => {
    it('applies a false filter as false rather than dropping it', async () => {
      // `aiEnabled: false` is a real filter, not an absent one. Treating falsy as "no filter" showed
      // every group when the operator asked for the AI-disabled ones.
      const { instance, queries } = service();
      await instance.list({ aiEnabled: false }, { limit: 25, offset: 0, sort: 'name', direction: 'ASC' });

      expect(queries[0].sql).toContain('g."aiEnabled"');
      expect(queries[0].params).toContain(false);
    });

    it('treats undefined as "either" and emits no clause', async () => {
      const { instance, queries } = service();
      await instance.list(
        { aiEnabled: undefined, automationEnabled: undefined },
        { limit: 25, offset: 0, sort: 'name', direction: 'ASC' },
      );

      // Both columns appear in the SELECT list regardless, so this has to look at the filter itself:
      // with no filters there is no outer WHERE at all, and the only bound values are the page bounds.
      const head = queries[0].sql.slice(0, queries[0].sql.indexOf('ORDER BY'));
      expect(head.slice(head.indexOf(') stats ON TRUE'))).not.toContain('WHERE');

      // With no filters the only bound values are the four the query always carries: the two ends
      // of today, then the page bounds.
      const [from, to, monthStart, limit, offset] = queries[0].params;
      expect(queries[0].params).toHaveLength(5);
      expect(from).toBeInstanceOf(Date);
      expect(to).toBeInstanceOf(Date);
      expect(monthStart).toBeInstanceOf(Date);
      expect([limit, offset]).toEqual([25, 0]);
    });

    it('builds the same WHERE for the page, its count and select-all-matching', async () => {
      // The three must not drift: if they do, "select all 1,842 matching" acts on a different set
      // than the one the operator was shown, and the bulk operation hits groups they never saw.
      const filter = { aiEnabled: false, isActive: true, search: 'german' };

      const listRun = service();
      await listRun.instance.list(filter, { limit: 25, offset: 0, sort: 'name', direction: 'ASC' });
      const idsRun = service();
      await idsRun.instance.idsMatching(filter, 10_000);

      // The *outer* WHERE: `lastIndexOf`, because the lateral subquery that computes the counters
      // carries a `WHERE m."groupId" = g.id` of its own that appears first.
      const whereOf = (sql: string) => {
        const head = sql.slice(0, sql.indexOf('ORDER BY'));
        return head.slice(head.lastIndexOf('WHERE')).trim();
      };

      // The page and its total.
      expect(whereOf(listRun.queries[0].sql)).toBe(
        listRun.queries[1].sql.slice(listRun.queries[1].sql.lastIndexOf('WHERE')).trim(),
      );
      // The page and the select-all resolution.
      expect(whereOf(listRun.queries[0].sql)).toBe(whereOf(idsRun.queries[0].sql));
      expect(listRun.queries[0].params.slice(0, 3)).toEqual(idsRun.queries[0].params.slice(0, 3));
    });

    it('matches a search against both the name and the external id', async () => {
      const { instance, queries } = service();
      await instance.list({ search: 'german' }, { limit: 25, offset: 0, sort: 'name', direction: 'ASC' });

      expect(queries[0].sql).toContain('ILIKE');
      expect(queries[0].params).toContain('%german%');
    });
  });

  describe('counters', () => {
    it('derives every counter in SQL rather than returning rows to count in JavaScript', async () => {
      const { instance, queries } = service();
      await instance.list({}, { limit: 25, offset: 0, sort: 'name', direction: 'ASC' });

      expect(queries[0].sql).toContain("FILTER (WHERE m.classification = 'BOT_MESSAGE')");
      expect(queries[0].sql).toContain("FILTER (WHERE m.classification = 'TEAM_MESSAGE')");
      expect(queries[0].sql).toMatch(/LIMIT \$\d+ OFFSET \$\d+/);
    });

    it('bounds the counter aggregate to one day instead of scanning all history per group', async () => {
      // The regression this guards against is a per-group lateral over the whole message table.
      // Postgres evaluates it for every matching group before applying LIMIT, so one page of 50
      // cost 191ms across 3,000 groups and 200k messages and grew with total history. Aggregating
      // one bounded day and joining made the same page 3ms.
      const { instance, queries } = service();
      await instance.list({}, { limit: 25, offset: 0, sort: 'messagesToday', direction: 'DESC' });

      const sql = queries[0].sql.replace(/\s+/g, ' ');
      expect(sql).toContain('WITH recent AS');
      expect(sql).toMatch(/WHERE m\."sentAt" >= \$\d+ AND m\."sentAt" < \$\d+ AND m\."groupId" IS NOT NULL/);
      // No correlated per-row subquery over messages.
      expect(sql).not.toContain('LATERAL');
    });
  });

  describe('today is one instant, not three', () => {
    it('bounds the day at both ends, from one pair of instants', async () => {
      // One WHERE in the CTE bounds the whole aggregate, so the three figures cannot straddle
      // midnight and describe two different days in one row.
      //
      // Both ends matter. `>= midnight` alone counts messages dated in the future, which WhatsApp
      // produces whenever a sending device's clock runs ahead — observed inflating a "today" count
      // from 12 to 23.
      const { instance, queries } = service();
      await instance.list({}, { limit: 25, offset: 0, sort: 'name', direction: 'ASC' });

      const dates = queries[0].params.filter((value): value is Date => value instanceof Date);
      // Today, tomorrow, and the start of the month the aggregate opens at.
      expect(dates).toHaveLength(3);
      const [today, tomorrow, monthStart] = dates;
      expect(tomorrow.getTime() - today.getTime()).toBe(24 * 60 * 60 * 1000);
      expect(monthStart.getTime()).toBeLessThanOrEqual(today.getTime());
      expect(monthStart.getDate()).toBe(1);
      expect(queries[0].sql).not.toContain('now()');
    });

    it('measures the day from local midnight, not UTC midnight', async () => {
      // "Today" is the operator's day. A team in Dhaka looking at 1am wants the day they are in,
      // not one that ends six hours away.
      const { instance, queries } = service();
      await instance.list({}, { limit: 25, offset: 0, sort: 'name', direction: 'ASC' });

      const day = queries[0].params.find((value) => value instanceof Date) as Date;
      expect(day.getHours()).toBe(0);
      expect(day.getMinutes()).toBe(0);
      expect(day.getSeconds()).toBe(0);
    });
  });
});
