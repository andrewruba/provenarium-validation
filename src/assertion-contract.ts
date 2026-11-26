import type { Assertion } from './schema.js';
import { csvExpectedRowsError } from './csv.js';

export type AssertionContractIssue = {
  field: 'comparison' | 'expected' | 'tolerance';
  code: string;
  message: string;
};

/** Recognize explicit regex constructs without interpreting a provider's pattern. */
function hasRegexSyntax(pattern: string): boolean {
  if (
    /\(\?(?:[:=!>#]|<[=!]|[imsx-]+[:)])/.test(pattern) ||
    /^\^.*\$$/s.test(pattern) ||
    /^\/.+\/[dgimsuvy]+$/s.test(pattern) ||
    /\([^)]*\|[^)]*\)/.test(pattern) ||
    /[\])](?:\+|\{\d+(?:,\d*)?\})/.test(pattern)
  )
    return true;
  // Avoid treating ordinary paths such as C:\\Documents as regex character classes.
  for (const token of pattern.matchAll(/\\[dDsSwWbBAZz]/g)) {
    const following = pattern[token.index + token[0].length];
    if (following === undefined || '+*?{}()[]|\\.^$-'.includes(following)) return true;
  }
  return false;
}

/** Runtime predicate rules remain separate from JSON shape so malformed drafts can be repaired. */
export function assertionContractIssues(
  assertion: Pick<Assertion, 'comparison' | 'expected' | 'tolerance'>,
): AssertionContractIssue[] {
  const issues: AssertionContractIssue[] = [];
  const add = (field: AssertionContractIssue['field'], code: string, message: string) =>
    issues.push({ field, code, message });
  const expected = assertion.expected;
  if (expected === undefined && !['present', 'absent'].includes(assertion.comparison))
    add('expected', 'missing_expected', 'missing expected result.');
  if (assertion.comparison === 'numeric') {
    if (typeof expected !== 'number' || !Number.isFinite(expected))
      add(
        'expected',
        'numeric_expected',
        'numeric comparison requires expected number and tolerance.',
      );
    if (
      typeof assertion.tolerance !== 'number' ||
      !Number.isFinite(assertion.tolerance) ||
      assertion.tolerance < 0
    )
      add(
        'tolerance',
        'numeric_tolerance',
        'numeric comparison requires expected number and tolerance.',
      );
  }
  if (assertion.comparison === 'matches') {
    if (typeof expected !== 'string' || expected.length > 200)
      add(
        'expected',
        'wildcard_expected',
        'wildcard pattern must be a string of at most 200 characters.',
      );
    if (typeof expected === 'string' && expected.length <= 200 && hasRegexSyntax(expected))
      add(
        'expected',
        'wildcard_regex',
        'matches supports literal text and the * wildcard, not regular expressions. Use contains_any for allowed literal alternatives or csv_equals for complete CSV rows.',
      );
  }
  if (assertion.comparison === 'contains_any') {
    if (
      !Array.isArray(expected) ||
      expected.length < 1 ||
      expected.length > 20 ||
      expected.some((value) => typeof value !== 'string' || !value.length || value.length > 200)
    )
      add(
        'expected',
        'alternatives_expected',
        'contains_any requires 1 to 20 nonempty literal strings of at most 200 characters each; matching is case-sensitive.',
      );
  }
  if (assertion.comparison === 'csv_equals') {
    const error = csvExpectedRowsError(expected);
    if (error) add('expected', 'csv_expected', error);
  }
  return issues;
}
