/**
 * Rows to CSV (`PROJECT_SPEC.md` §105).
 *
 * Separated from the controller so it can be tested directly. Two rules, both because the failure
 * is silent:
 *
 *  * **Every value is quoted and internal quotes doubled** (RFC 4180). A stray quote shifts every
 *    later column by one, and nobody notices until a figure is attributed to the wrong customer.
 *  * **A value that begins with `=`, `+`, `-` or `@` is prefixed with an apostrophe.** Excel and
 *    Sheets execute those as formulas on open, which turns a support export into code running on
 *    an operator's laptop. Only a *leading* one is defused: mangling every value containing a minus
 *    sign would corrupt real data to prevent a problem that is not there.
 */
export function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '';

  const columns = Object.keys(rows[0]);
  const lines = [columns.map(escapeCsv).join(',')];

  for (const row of rows) {
    lines.push(columns.map((column) => escapeCsv(row[column])).join(','));
  }

  return lines.join('\n');
}

export function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) return '';

  const raw =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);

  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;

  return `"${guarded.replace(/"/g, '""')}"`;
}
