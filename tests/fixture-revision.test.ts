import { describe, expect, it } from 'vitest';
import { planSchema, ursSchema } from '../src/schema.js';
import {
  applyPlanEdits,
  makePlanEditsSchema,
  planEditCatalog,
  PlanEditError,
  type PlanEditOptions,
} from '../src/authoring/plan-edits.js';

const urs = ursSchema.parse({
  schema_version: 1,
  document: {
    id: 'URS',
    revision: '1',
    title: 'Arithmetic',
    intended_use: 'Calculate reviewed results.',
  },
  families: [
    {
      id: 'math',
      title: 'Arithmetic',
      requirements: [
        { id: 'R1', title: 'Division', statement: 'Display 10 divided by 4 as 2.500.' },
      ],
    },
  ],
});
function baseline() {
  return {
    plan: planSchema.parse({
      schema_version: 1,
      runtime_version: 1,
      id: 'IOQ',
      title: 'Arithmetic check',
      urs_revision: '1',
      target: { url: 'https://example.test/', allowed_origins: ['https://example.test'] },
      environment: {},
      fixtures: ['fixtures/derivation.txt'],
      obligations: [
        {
          id: 'OB1',
          requirement_id: 'R1',
          source: 'R1/statement',
          statement: 'Display the correctly formatted quotient.',
          assertion_ids: ['A1'],
        },
      ],
      cases: [
        {
          id: 'OQ1',
          title: 'Quotient',
          classification: 'OQ',
          requirements: ['R1'],
          steps: [
            {
              id: '01',
              instruction: 'Read the quotient.',
              actions: [{ op: 'navigate', url: '/' }],
              assertions: [
                {
                  id: 'A1',
                  locator: { by: 'testId', value: 'quotient' },
                  comparison: 'equals',
                  expected: '2.400',
                },
              ],
              evidence: [],
            },
          ],
        },
      ],
    }),
    fixtures: [{ path: 'fixtures/derivation.txt', content: '10 / 4 = 2.4; display 2.400.\n' }],
  };
}
const options: PlanEditOptions = { mode: 'review', urs, allowDraftExpectationRevision: true };
const edit = {
  op: 'revise_fixture',
  path: 'fixtures/derivation.txt',
  content: '10 / 4 = 2.5; display 2.500.\n',
  reason: 'Correct the independent division arithmetic and its three-decimal display string.',
};

describe('provisional fixture revisions', () => {
  it('revises calculation text and its expected assertion atomically with before/after rationale', () => {
    const base = baseline();
    const original = structuredClone(base);
    const result = applyPlanEdits(
      base,
      { edits: [edit, { op: 'revise_assertion', assertion_id: 'A1', expected: '2.500' }] },
      options,
    );
    expect(base).toEqual(original);
    expect(result.value.fixtures).toEqual([{ path: edit.path, content: edit.content }]);
    expect(result.value.plan.cases[0].steps[0].assertions[0].expected).toBe('2.500');
    expect(result.value.plan.fixtures).toEqual(original.plan.fixtures);
    expect(result.changes[0]).toEqual({
      op: 'revise_fixture',
      target: edit.path,
      before: original.fixtures[0],
      after: { path: edit.path, content: edit.content, reason: edit.reason },
    });
    expect(planEditCatalog(base, options).revisable_fixtures).toEqual([edit.path]);
  });

  it.each([
    { label: 'existing candidate review', permission: { mode: 'review' as const } },
    {
      label: 'changed requirement in an existing candidate',
      permission: { mode: 'review' as const, authorizedRequirementChanges: new Set(['R1']) },
    },
    {
      label: 'technical correction',
      permission: {
        mode: 'technical' as const,
        allowDraftExpectationRevision: true,
        authorizedRequirementChanges: new Set(['R1']),
      },
    },
    {
      label: 'rehearsal repair',
      permission: {
        mode: 'review' as const,
        allowDraftExpectationRevision: true,
        proceduralOnly: true,
      },
    },
  ])('does not expose or apply fixture replacement during $label', ({ permission }) => {
    const base = baseline();
    const original = structuredClone(base);
    const protectedOptions = { urs, ...permission };
    expect(makePlanEditsSchema(base, protectedOptions).safeParse({ edits: [edit] }).success).toBe(
      false,
    );
    expect(planEditCatalog(base, protectedOptions).revisable_fixtures).toEqual([]);
    expect(() => applyPlanEdits(base, { edits: [edit] }, protectedOptions)).toThrow(PlanEditError);
    expect(base).toEqual(original);
  });

  it.each([
    'fixtures/new.txt',
    ' fixtures/derivation.txt',
    'fixtures/../derivation.txt',
    '/tmp/derivation.txt',
    'fixtures/calculation.js',
  ])('rejects nonmatching or unsafe fixture path %s without applying other edits', (path) => {
    const base = baseline();
    const original = structuredClone(base);
    expect(() =>
      applyPlanEdits(
        base,
        {
          edits: [
            { op: 'revise_assertion', assertion_id: 'A1', expected: '2.500' },
            { ...edit, path },
          ],
        },
        options,
      ),
    ).toThrow(PlanEditError);
    expect(base).toEqual(original);
  });

  it('protects normative references even when an invalid draft also presents one as a fixture', () => {
    const normative = structuredClone(urs);
    normative.families[0].requirements[0].references = [edit.path];
    const base = baseline();
    const scoped = { ...options, urs: normative };
    expect(planEditCatalog(base, scoped).revisable_fixtures).toEqual([]);
    expect(() => applyPlanEdits(base, { edits: [edit] }, scoped)).toThrow(/protected/);
    expect(base.fixtures[0].content).not.toBe(edit.content);
  });

  it('rejects unsupported existing text paths, undeclared fixtures, duplicates and additions disguised as revisions', () => {
    const unsafe = baseline();
    unsafe.fixtures[0].path = unsafe.plan.fixtures[0] = 'fixtures/calculation.js';
    expect(() =>
      applyPlanEdits(unsafe, { edits: [{ ...edit, path: unsafe.fixtures[0].path }] }, options),
    ).toThrow(/protected/);
    const undeclared = baseline();
    undeclared.plan.fixtures = [];
    expect(() => applyPlanEdits(undeclared, { edits: [edit] }, options)).toThrow(/protected/);
    const duplicate = baseline();
    duplicate.fixtures.push(structuredClone(duplicate.fixtures[0]));
    expect(() => applyPlanEdits(duplicate, { edits: [edit] }, options)).toThrow(
      /one exact existing/,
    );
    const newPath = 'fixtures/new.txt';
    expect(() =>
      applyPlanEdits(
        baseline(),
        {
          edits: [
            { op: 'add_fixture', value: { path: newPath, content: 'new' } },
            { ...edit, path: newPath },
          ],
        },
        options,
      ),
    ).toThrow(/protected/);
  });

  it('requires a reason, rejects no-op and duplicate writes, and leaves the original untouched', () => {
    const base = baseline();
    const original = structuredClone(base);
    expect(() => applyPlanEdits(base, { edits: [{ ...edit, reason: ' ' }] }, options)).toThrow(
      PlanEditError,
    );
    expect(() =>
      applyPlanEdits(base, { edits: [{ ...edit, content: base.fixtures[0].content }] }, options),
    ).toThrow(/made no change/);
    expect(() =>
      applyPlanEdits(base, { edits: [edit, { ...edit, content: 'another result' }] }, options),
    ).toThrow(/Conflicting duplicate edit/);
    expect(base).toEqual(original);
  });
});
