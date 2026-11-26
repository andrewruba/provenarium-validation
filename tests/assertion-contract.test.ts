import { describe, expect, it } from 'vitest';
import { assertionContractIssues } from '../src/assertion-contract.js';
import { assertionSchema, type Assertion } from '../src/schema.js';

function issues(
  comparison: Assertion['comparison'],
  expected?: Assertion['expected'],
  tolerance?: number,
) {
  return assertionContractIssues({ comparison, expected, tolerance });
}

describe('assertion runtime contracts', () => {
  it('keeps malformed predicates available for scoped repair after their JSON shape parses', () => {
    const malformed = assertionSchema.parse({
      id: 'MESSAGE',
      variable: 'message',
      comparison: 'matches',
      expected: '(?:required|missing|enter)',
    });
    expect(assertionContractIssues(malformed)).toEqual([
      expect.objectContaining({ field: 'expected', code: 'wildcard_regex' }),
    ]);
  });

  it.each([
    '(?i:required|missing|enter)',
    '(?:invalid|ASCII|not allowed|must match)',
    '(?:decimal|notation|valid number)',
    '(?:greater than zero|positive|greater than 0)',
    '(?:exceed|no greater|greater than stock|less than or equal)',
    '(?:already|duplicate|exists)',
    '(required|missing)',
    '^Saved record$',
    '/saved/i',
    '\\d{3}',
    '[0-9]{3}',
  ])('rejects regex syntax in a short wildcard pattern: %s', (pattern) => {
    expect(pattern.length).toBeLessThan(200);
    expect(issues('matches', pattern)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'wildcard_regex' })]),
    );
  });

  it.each([
    'Stock (mg/mL)',
    'Saved record *',
    '$5.00',
    '1 + 1 = 2',
    'Choose (yes)?',
    'file?.csv',
    'C:\\Documents\\*',
    'Report [draft]',
  ])('allows literal punctuation and supported wildcards: %s', (pattern) => {
    expect(issues('matches', pattern)).toEqual([]);
  });

  it('preserves the wildcard length and expected-value constraints', () => {
    expect(issues('matches', 'a'.repeat(200))).toEqual([]);
    for (const value of ['a'.repeat(201), false, [], null])
      expect(issues('matches', value)).toContainEqual(
        expect.objectContaining({ field: 'expected', code: 'wildcard_expected' }),
      );
  });

  it('requires a finite numeric expected value and a finite nonnegative tolerance', () => {
    expect(issues('numeric', 1.25, 0.001)).toEqual([]);
    expect(issues('numeric', 0, 0)).toEqual([]);
    for (const value of ['1.25', null, Infinity, NaN])
      expect(issues('numeric', value, 0)).toContainEqual(
        expect.objectContaining({ field: 'expected', code: 'numeric_expected' }),
      );
    for (const tolerance of [undefined, -1, Infinity, NaN])
      expect(issues('numeric', 1, tolerance)).toContainEqual(
        expect.objectContaining({ field: 'tolerance', code: 'numeric_tolerance' }),
      );
  });

  it('reports missing expectations except for presence and absence predicates', () => {
    expect(issues('equals')).toEqual([
      { field: 'expected', code: 'missing_expected', message: 'missing expected result.' },
    ]);
    expect(issues('present')).toEqual([]);
    expect(issues('absent')).toEqual([]);
    expect(issues('equals', null)).toEqual([]);
  });

  it('accepts finite alternatives as literal strings, including meaningful whitespace', () => {
    expect(issues('contains_any', ['record saved', 'record created'])).toEqual([]);
    expect(issues('contains_any', [' '])).toEqual([]);
    expect(
      issues(
        'contains_any',
        Array.from({ length: 20 }, () => 'a'.repeat(200)),
      ),
    ).toEqual([]);
  });

  it.each([null, [], [''], [false], ['a'.repeat(201)], Array.from({ length: 21 }, () => 'saved')])(
    'rejects malformed or unbounded alternatives: %j',
    (expected) => {
      expect(issues('contains_any', expected)).toContainEqual(
        expect.objectContaining({ field: 'expected', code: 'alternatives_expected' }),
      );
    },
  );

  it('accepts exact CSV rows and an empty CSV expectation', () => {
    expect(issues('csv_equals', [])).toEqual([]);
    expect(
      issues('csv_equals', [
        ['Sample ID', 'Volume'],
        ['Sample, A', '1.250'],
      ]),
    ).toEqual([]);
    expect(issues('csv_equals', [['Sample ID', 'Volume']])).toEqual([]);
  });

  it.each([null, 'Sample ID,Volume', [[]], [['Sample ID', 'Volume'], ['A']], [[1, 2]]])(
    'rejects malformed CSV expected rows: %j',
    (expected) => {
      expect(issues('csv_equals', expected)).toContainEqual(
        expect.objectContaining({ field: 'expected', code: 'csv_expected' }),
      );
    },
  );
});
