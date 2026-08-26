import { toCsv, escapeCsv } from './csv';

/**
 * CSV escaping.
 *
 * Pinned because the failure modes are silent. A quote that is not doubled shifts every subsequent
 * column by one and nobody notices until a number is attributed to the wrong customer; and a value
 * beginning with `=` is executed as a formula by Excel and Sheets the moment somebody opens the
 * file, which turns a support export into code running on an operator's laptop.
 */
describe('CSV export escaping (§105)', () => {
  it('quotes every value and doubles internal quotes', () => {
    expect(escapeCsv('plain')).toBe('"plain"');
    expect(escapeCsv('has "quotes" inside')).toBe('"has ""quotes"" inside"');
    expect(escapeCsv('comma, separated')).toBe('"comma, separated"');
    expect(escapeCsv('line\nbreak')).toBe('"line\nbreak"');
  });

  it('renders null and undefined as empty rather than the words', () => {
    // '"null"' in a spreadsheet cell is worse than blank: it looks like data.
    expect(escapeCsv(null)).toBe('');
    expect(escapeCsv(undefined)).toBe('');
  });

  it('defuses values a spreadsheet would execute as a formula', () => {
    for (const dangerous of ['=1+1', '+SUM(A1)', '-2', '@import', '=cmd|/c calc']) {
      expect(escapeCsv(dangerous)).toMatch(/^"'/);
    }
  });

  it('leaves ordinary text that merely contains those characters alone', () => {
    // Only a *leading* formula character is dangerous. Mangling every value with a minus sign in
    // it would corrupt real data to prevent a problem that is not there.
    expect(escapeCsv('a-b')).toBe('"a-b"');
    expect(escapeCsv('2 + 2')).toBe('"2 + 2"');
  });

  it('serialises dates as ISO and objects as JSON', () => {
    expect(escapeCsv(new Date('2026-08-24T10:00:00.000Z'))).toBe('"2026-08-24T10:00:00.000Z"');
    expect(escapeCsv({ a: 1 })).toBe('"{""a"":1}"');
  });

  it('writes a header row from the first row\'s keys', () => {
    const csv = toCsv([
      { id: '1', status: 'OPEN' },
      { id: '2', status: 'CLOSED' },
    ]);

    expect(csv.split('\n')[0]).toBe('"id","status"');
    expect(csv.split('\n')).toHaveLength(3);
  });

  it('returns nothing at all for no rows', () => {
    expect(toCsv([])).toBe('');
  });
});
