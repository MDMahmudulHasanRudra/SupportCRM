import { dataSourceOptions } from './data-source';

/**
 * One definition of a day, across Node and SQL.
 *
 * The application computes some day boundaries in Node (`new Date(y, m, d)`, which uses `TZ`) and
 * others in Postgres (`date_trunc('day', now())`, which uses the session timezone). Left alone
 * those are different zones: the container sets `TZ=Asia/Dhaka` while Postgres defaults to
 * `Etc/UTC`, six hours apart.
 *
 * The symptom is nasty because it is partial and time-of-day dependent. Between local midnight and
 * 6am, a "messages today" figure computed in SQL covered a different day from one computed in
 * Node — so the groups list and the support roster disagreed, both looked plausible, and neither
 * was obviously wrong. After 6am they agreed again and the discrepancy vanished.
 *
 * Pinning the session on the connection is what makes a query written later inherit the right
 * answer instead of having to remember. This test fails if that pin is removed.
 */
describe('database session timezone', () => {
  it('pins the Postgres session to the application timezone', () => {
    const options = (dataSourceOptions as { extra?: { options?: string } }).extra?.options;

    expect(options).toBeDefined();
    expect(options).toContain('-c timezone=');
  });

  it('uses the configured TZ rather than hard-coding a zone', () => {
    // A literal zone here would be correct for one deployment and silently wrong for the next.
    const options = (dataSourceOptions as { extra?: { options?: string } }).extra?.options ?? '';
    expect(options).toContain(process.env.TZ ?? 'UTC');
  });

  it('never enables synchronize, whatever else changes about the connection', () => {
    // Unrelated to timezone, but this is the file that describes the connection and the guarantee
    // is worth pinning where somebody editing it will see it.
    expect(dataSourceOptions.synchronize).toBe(false);
  });
});
