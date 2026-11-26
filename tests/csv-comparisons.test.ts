import { describe, expect, it } from 'vitest';
import {
  CSV_MAX_BYTES,
  CSV_MAX_CELLS,
  CSV_MAX_COLUMNS,
  CSV_MAX_ROWS,
  csvExpectedRowsError,
  parseCsv,
} from '../src/csv.js';
import type { Assertion } from '../src/schema.js';
import { compare } from '../src/runtime/engine.js';

const csvAssertion = (expected: unknown): Assertion => ({
  id: 'CSV',
  variable: 'export.text',
  read: 'text',
  comparison: 'csv_equals',
  expected,
});
const alternativesAssertion = (expected: unknown): Assertion => ({
  id: 'MESSAGE',
  variable: 'message',
  read: 'text',
  comparison: 'contains_any',
  expected,
});

describe('bounded CSV comparison', () => {
  const rows = [
    ['Sample ID', 'Stock (mg/mL)', 'Final volume (mL)'],
    ['A', '8.000', '1.250'],
  ];
  it.each([
    'Sample ID,Stock (mg/mL),Final volume (mL)\nA,8.000,1.250',
    '\uFEFF"Sample ID","Stock (mg/mL)","Final volume (mL)"\r\n"A","8.000","1.250"\r\n',
    '"Sample ID",Stock (mg/mL),Final volume (mL)\nA,"8.000",1.250\n',
  ])('compares exact cells independently of standard CSV encoding', (text) => {
    expect(parseCsv(text)).toEqual(rows);
    expect(compare(text, csvAssertion(rows))).toBe(true);
  });

  it('preserves quoted commas, doubled quotes, embedded newlines, and whitespace', () => {
    const text = 'Name,Note,Value\r\n"A,1"," line 1\r\n""line 2"" ",1.000\r\n';
    const expected = [
      ['Name', 'Note', 'Value'],
      ['A,1', ' line 1\r\n"line 2" ', '1.000'],
    ];
    expect(parseCsv(text)).toEqual(expected);
    expect(compare(text, csvAssertion(expected))).toBe(true);
  });

  it('distinguishes empty files, blank records, trailing fields, and header-only data', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('\uFEFF')).toEqual([]);
    expect(parseCsv('\n')).toEqual([['']]);
    expect(parseCsv('""')).toEqual([['']]);
    expect(parseCsv(',')).toEqual([['', '']]);
    expect(parseCsv('a,b,\n')).toEqual([['a', 'b', '']]);
    expect(parseCsv('a,b\r\n')).toEqual([['a', 'b']]);
    expect(compare('', csvAssertion([]))).toBe(true);
    expect(compare('\n', csvAssertion([]))).toBe(false);
    expect(compare('a,b\n', csvAssertion([['a', 'b']]))).toBe(true);
  });

  it.each([
    'Sample ID,Stock (mg/mL),Final volume (mL)\nA,8.000,1.25',
    'Sample ID,Stock (mg/mL),Final volume (mL)\nA, 8.000,1.250',
    'Sample ID,Final volume (mL),Stock (mg/mL)\nA,1.250,8.000',
    'Sample ID,Stock (mg/mL),Final volume (mL)\nA,8.000,1.250\nB,8.000,1.250',
  ])('preserves exact row shape, values, order, and numeric formatting', (text) => {
    expect(compare(text, csvAssertion(rows))).toBe(false);
  });

  it('does not reorder data rows', () => {
    const expected = [['ID'], ['A'], ['B']];
    expect(compare('ID\nA\nB\n', csvAssertion(expected))).toBe(true);
    expect(compare('ID\nB\nA\n', csvAssertion(expected))).toBe(false);
  });

  it.each(['"unterminated', '"closed"tail', 'un"quoted', 'a\rb', 'a,b\nc', '"a" ,b'])(
    'rejects malformed CSV without accepting partial rows: %s',
    (text) => {
      expect(parseCsv(text)).toBeUndefined();
      expect(compare(text, csvAssertion([['a', 'b']]))).toBe(false);
    },
  );

  it('bounds actual UTF-8 input, row count, column count, and total fields', () => {
    expect(parseCsv('x'.repeat(CSV_MAX_BYTES + 1))).toBeUndefined();
    expect(parseCsv('é'.repeat(CSV_MAX_BYTES / 2 + 1))).toBeUndefined();
    expect(
      parseCsv(
        Array(CSV_MAX_ROWS + 1)
          .fill('a')
          .join('\n'),
      ),
    ).toBeUndefined();
    expect(
      parseCsv(
        Array(CSV_MAX_COLUMNS + 1)
          .fill('a')
          .join(','),
      ),
    ).toBeUndefined();
    const wideRow = Array(100).fill('a').join(',');
    expect(
      parseCsv(
        Array(CSV_MAX_CELLS / 100 + 1)
          .fill(wideRow)
          .join('\n'),
      ),
    ).toBeUndefined();
  });

  it('rejects invalid expected tables and non-string observations', () => {
    for (const value of [
      null,
      'a,b',
      [1],
      [[]],
      [['a'], ['a', 'b']],
      [[1]],
      [['a'.repeat(CSV_MAX_BYTES + 1)]],
    ]) {
      expect(csvExpectedRowsError(value)).toBeTruthy();
      expect(compare('a,b', csvAssertion(value))).toBe(false);
    }
    expect(csvExpectedRowsError([])).toBeUndefined();
    expect(csvExpectedRowsError(rows)).toBeUndefined();
    expect(compare(rows, csvAssertion(rows))).toBe(false);
  });

  it('applies the same size limits to declared expected tables', () => {
    for (const expected of [
      Array(CSV_MAX_ROWS + 1).fill(['x']),
      [Array(CSV_MAX_COLUMNS + 1).fill('x')],
      Array(CSV_MAX_CELLS / 100 + 1).fill(Array(100).fill('x')),
      [['é'.repeat(CSV_MAX_BYTES / 2 + 1)]],
    ])
      expect(csvExpectedRowsError(expected)).toBeTruthy();
  });
});

describe('literal text alternatives', () => {
  it('matches any declared literal alternative with case sensitivity', () => {
    const assertion = alternativesAssertion(['required', 'missing']);
    expect(compare('A value is required.', assertion)).toBe(true);
    expect(compare('A value is missing.', assertion)).toBe(true);
    expect(compare('A value is REQUIRED.', assertion)).toBe(false);
    expect(compare('A value is present.', assertion)).toBe(false);
    expect(compare('A value is required.', alternativesAssertion(['(?:required|missing)']))).toBe(
      false,
    );
    expect(compare(['required'], assertion)).toBe(false);
  });

  it('requires bounded nonempty literal alternatives without coercion', () => {
    for (const value of [[], [''], [true], ['x'.repeat(201)], Array(21).fill('x'), 'x'])
      expect(compare('x', alternativesAssertion(value))).toBe(false);
    expect(compare('a b', alternativesAssertion([' ']))).toBe(true);
  });
});
