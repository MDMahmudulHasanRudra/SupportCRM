import { ReportsService } from './reports.service';

/**
 * Time to first response, and the interval that is not one.
 *
 * An outbound message can legitimately predate its own conversation. Messages sent before the
 * conversation resolver existed were stored with no `conversationId`, and the orphan backfill later
 * attached them to a conversation a *newer* message had created. One such row exists in the live
 * database — sent 17:29:27, attached to a conversation created 17:54:27 — and averaging it in
 * produced a reported first response of **minus 1,500 seconds**.
 *
 * The failure worth guarding is not the visible one. A single negative among positives does not
 * print as nonsense; it quietly pulls the average down and reports a number that looks entirely
 * reasonable and is wrong. That is why this filters rather than clamping to zero: clamping would
 * treat "not a response" as "an instant response", which is a different lie.
 */

function service() {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params: unknown[]) => {
    queries.push({ sql, params });
    return [{ avg_seconds: '42', measured: '3', skipped: '1' }];
  });

  const repo = {
    manager: { query },
    createQueryBuilder: () => ({
      select: () => ({ addSelect: () => ({ where: () => ({ groupBy: () => ({ getRawMany: async () => [] }) }) }) }),
    }),
    count: async () => 0,
  };

  const instance = new ReportsService(repo as never, repo as never, repo as never, repo as never, repo as never, repo as never, repo as never);
  return { instance, queries };
}

/** Reaches the private method under test without standing up a Nest container. */
const responseTimes = (instance: ReportsService, window: { from: Date; to: Date }) =>
  (instance as unknown as { responseTimes: (w: unknown) => Promise<unknown> }).responseTimes(window);

const WINDOW = { from: new Date('2026-08-01'), to: new Date('2026-08-31') };

describe('time to first response', () => {
  it('excludes responses that predate their own conversation', async () => {
    const { instance, queries } = service();
    await responseTimes(instance, WINDOW);

    const sql = queries[0].sql.replace(/\s+/g, ' ');
    expect(sql).toContain('FILTER (WHERE first_out.sent_at > c."createdAt")');
  });

  it('filters rather than clamping the interval to zero', async () => {
    // Clamping would report "not a response" as "an instant response" — a different wrong answer,
    // and a more flattering one.
    const { instance, queries } = service();
    await responseTimes(instance, WINDOW);
    const sql = queries[0].sql;

    expect(sql).not.toContain('GREATEST');
    expect(sql).not.toContain('ABS(');
  });

  it('reports how many conversations the average is over, and how many were skipped', async () => {
    // An average with no denominator cannot be sanity-checked by the person reading it.
    const { instance } = service();
    const result = (await responseTimes(instance, WINDOW)) as {
      firstResponseSeconds: number | null;
      firstResponseMeasured: number;
      firstResponseSkipped: number;
    };

    expect(result.firstResponseSeconds).toBe(42);
    expect(result.firstResponseMeasured).toBe(3);
    expect(result.firstResponseSkipped).toBe(1);
  });

  it('returns null rather than a number when nothing was measurable', async () => {
    const queries: Array<unknown> = [];
    const query = jest.fn(async () => {
      queries.push(1);
      return [{ avg_seconds: null, measured: '0', skipped: '2' }];
    });
    const repo = { manager: { query } };
    const instance = new ReportsService(
      repo as never, repo as never, repo as never, repo as never, repo as never, repo as never, repo as never,
    );

    const result = (await responseTimes(instance, WINDOW)) as {
      firstResponseSeconds: number | null;
      firstResponseSkipped: number;
    };

    // Null, not zero. "No conversation could be measured" and "every response was instant" are
    // different facts and must not render the same.
    expect(result.firstResponseSeconds).toBeNull();
    expect(result.firstResponseSkipped).toBe(2);
  });
});
