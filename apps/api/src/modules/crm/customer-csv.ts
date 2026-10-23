import { BadRequestException } from '@nestjs/common';

export const CUSTOMER_COLUMNS = ['code','name','phone','email','company','country','service','ownerUsername','status'] as const;
export const CSV_MAX_BYTES = 512 * 1024;
export const CSV_MAX_ROWS = 250;

/** Strict RFC-style CSV, including escaped quotes and quoted multiline fields. */
export function parseCustomerCsv(input: string): Array<Record<string, string>> {
  if (Buffer.byteLength(input, 'utf8') > CSV_MAX_BYTES) throw new BadRequestException('CSV must be at most 512 KiB.');
  const text = input.replace(/^\uFEFF/, '');
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/.test(text)) throw new BadRequestException('Use a UTF-8 CSV without control characters.');
  const rows: string[][] = []; let row: string[] = []; let field = ''; let quoted = false; let closed = false;
  const cell = () => { row.push(field); field = ''; closed = false; };
  const line = () => { cell(); if (row.some(v => v.trim())) rows.push(row); row = []; if (rows.length > CSV_MAX_ROWS + 1) throw new BadRequestException('Import at most 250 customers at a time.'); };
  for (let i=0; i<text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i+1] === '"') { field += '"'; i++; }
      else if (ch === '"') { quoted = false; closed = true; }
      else field += ch;
    } else if (ch === ',') cell();
    else if (ch === '\r' || ch === '\n') { if (ch === '\r' && text[i+1] === '\n') i++; line(); }
    else if (ch === '"' && !field && !closed) quoted = true;
    else { if (closed || ch === '"') throw new BadRequestException('Malformed CSV quoting. Use the supplied template.'); field += ch; }
  }
  if (quoted) throw new BadRequestException('A quoted CSV field was not closed.');
  if (field || row.length || closed) line();
  const headers = rows.shift()?.map(h => h.trim());
  if (!headers?.includes('name') || new Set(headers).size !== headers.length || headers.some(h => !(CUSTOMER_COLUMNS as readonly string[]).includes(h))) {
    throw new BadRequestException('Use unique template columns, including name. Unknown columns are not accepted.');
  }
  if (!rows.length) throw new BadRequestException('The CSV has no customer rows.');
  return rows.map((cells, index) => {
    if (cells.length !== headers.length) throw new BadRequestException(`CSV record ${index+2} has the wrong number of columns.`);
    return Object.fromEntries(headers.map((key, i) => [key, cells[i].trim()]));
  });
}

/** Quote every field and neutralize spreadsheet formulas, including whitespace-prefixed formulas. */
export function csvLine(values: unknown[]): string {
  return values.map(value => {
    const text = String(value ?? '');
    return `"${(/^[\s\uFEFF]*[=+\-@\t\r\n]/.test(text) ? "'" : '') + text.replace(/"/g, '""')}"`;
  }).join(',') + '\r\n';
}
