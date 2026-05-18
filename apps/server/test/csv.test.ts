import { describe, it, expect } from 'vitest';
import { safeCell, toCsv } from '../src/services/csv.js';

describe('CSV injection protection', () => {
  it('prefixes formula-leading cells with apostrophe', () => {
    /* When the cell has no comma/quote/newline, no RFC 4180 quoting is needed. */
    expect(safeCell('=SUM(A1:A9)')).toBe(`'=SUM(A1:A9)`);
    expect(safeCell('+CMD')).toBe(`'+CMD`);
    expect(safeCell('-1')).toBe(`'-1`);
    expect(safeCell('@import')).toBe(`'@import`);
    expect(safeCell('\tlooks tab')).toBe(`'\tlooks tab`);
  });
  it('prefixes AND quotes formula cells that contain commas', () => {
    expect(safeCell('=A,B')).toBe(`"'=A,B"`);
  });
  it('does not prefix safe cells', () => {
    expect(safeCell('hello')).toBe('hello');
    expect(safeCell(42)).toBe('42');
    expect(safeCell(null)).toBe('');
  });
  it('quotes cells with commas, quotes, newlines per RFC 4180', () => {
    expect(safeCell('a,b')).toBe('"a,b"');
    expect(safeCell('a"b')).toBe('"a""b"');
    expect(safeCell('a\nb')).toBe('"a\nb"');
  });
});

describe('toCsv', () => {
  it('emits BOM + header + rows + CRLF + neutralises formula injection', () => {
    const csv = toCsv(['a', 'b'], [{ a: 1, b: 'two,three' }, { a: '=BAD', b: 'ok' }]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('a,b\r\n');
    /* Injected formula appears with leading apostrophe — no quotes because no comma. */
    expect(csv).toContain(`\r\n'=BAD,ok`);
    expect(csv.endsWith('\r\n')).toBe(true);
  });
});
