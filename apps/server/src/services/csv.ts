/**
 * CSV export helpers.
 *
 * Every cell is run through `safeCell()` which:
 *   - quotes when the value contains comma, quote, newline, CR
 *   - doubles inner quotes per RFC 4180
 *   - prepends a single `'` (apostrophe) to any cell starting with =, +, -, @, tab
 *     to neutralise CSV injection / Excel formula execution
 *
 * Output is UTF-8 with a BOM so Excel opens it correctly.
 */

const INJECTION_PREFIX = /^[=+\-@\t\r]/;

/** Quote / escape a single cell. */
export function safeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'string' ? value : String(value);
  /* Defuse formula-injection vectors. */
  if (INJECTION_PREFIX.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) {
    s = `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Build a CSV string. `rows` are records keyed by `headers`. */
export function toCsv<T extends Record<string, unknown>>(headers: string[], rows: T[]): string {
  const lines: string[] = [];
  lines.push(headers.map(safeCell).join(','));
  for (const r of rows) {
    lines.push(headers.map(h => safeCell(r[h])).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** A Fastify-friendly download response. */
export function csvResponse(reply: any, filename: string, body: string): void {
  reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`)
    .send(body);
}
