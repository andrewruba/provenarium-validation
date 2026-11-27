import { expect, it } from 'vitest';
import { planSchema, ursSchema } from '../src/schema.js';
import {
  applyPlanEdits,
  makePlanEditsSchema,
  planEditCatalog,
  PlanEditError,
  type PlanEditOptions,
} from '../src/authoring/plan-edits.js';
import { compileStructuredOutput } from '../src/authoring/structured-output.js';
import { validatePlanStructure } from '../src/compiler.js';

const urs = ursSchema.parse({
  schema_version: 1,
  document: {
    id: 'URS',
    title: 'Scoped tests',
    revision: '1',
    intended_use: 'Verify preserved state.',
  },
  families: [
    {
      id: 'state',
      title: 'State',
      requirements: [
        { id: 'R1', title: 'First state', statement: 'Retain the saved value 1.250.' },
        { id: 'R2', title: 'Second state', statement: 'Retain the saved value 2.500.' },
      ],
    },
  ],
});
function step(id: string, assertion: string, expected = '1.250') {
  return {
    id,
    instruction: 'Inspect the saved value.',
    actions: [{ op: 'navigate' as const, url: '/' }],
    assertions: [
      {
        id: assertion,
        locator: { by: 'testId' as const, value: 'saved' },
        comparison: 'equals' as const,
        expected,
      },
    ],
    evidence: [],
  };
}
function baseline() {
  const plan = planSchema.parse({
    schema_version: 1,
    runtime_version: 1,
    id: 'PLAN',
    title: 'Scoped protocol',
    urs_revision: '1',
    target: { url: 'https://example.test/', allowed_origins: ['https://example.test'] },
    environment: {},
    fixtures: ['fixtures/expected.txt'],
    access: [
      {
        id: 'SHARED',
        role: 'Public user',
        state: 'signed_out',
        mode: 'anonymous',
        purpose: 'Inspect saved state.',
        cases: ['C3', 'C4'],
      },
    ],
    obligations: [
      {
        id: 'OB1',
        requirement_id: 'R1',
        source: 'R1/statement',
        statement: 'First value is retained.',
        manual_case_ids: ['C1'],
        assertion_ids: ['A3'],
      },
      {
        id: 'OB2',
        requirement_id: 'R2',
        source: 'R2/statement',
        statement: 'Second value is retained.',
        manual_case_ids: ['C2'],
        assertion_ids: ['A4'],
      },
    ],
    questions: [
      {
        id: 'PREP',
        kind: 'execution_preparation',
        question: 'Prepare disposable profiles.',
        case_ids: ['C1', 'C2'],
      },
      { id: 'Q2', question: 'Which second-state policy applies?', requirement: 'R2' },
    ],
    cases: [
      {
        id: 'C1',
        title: 'First manual',
        classification: 'OQ',
        requirements: ['R1'],
        manual: true,
        manual_procedure: 'Inspect the first state.',
        manual_expected: 'Saved value remains 1.250.',
        prerequisites: ['Prepare a disposable profile.'],
        steps: [],
      },
      {
        id: 'C2',
        title: 'Second manual',
        classification: 'OQ',
        requirements: ['R2'],
        manual: true,
        manual_procedure: 'Inspect the second state.',
        manual_expected: 'Saved value remains 2.500.',
        prerequisites: ['Prepare a disposable profile.'],
        steps: [],
      },
      {
        id: 'C3',
        title: 'First automated',
        classification: 'OQ',
        requirements: ['R1'],
        actor: 'SHARED',
        steps: [step('01', 'A3')],
      },
      {
        id: 'C4',
        title: 'Second automated',
        classification: 'OQ',
        requirements: ['R2'],
        actor: 'SHARED',
        steps: [step('01', 'A4', '2.500')],
      },
    ],
  });
  return {
    plan,
    fixtures: [
      { path: 'fixtures/expected.txt', content: 'Independent expected values: 1.250 and 2.500.' },
    ],
  };
}
const options: PlanEditOptions = { mode: 'review', urs, allowManualConversion: true };
function conversion(caseId = 'C1') {
  const c = baseline().plan.cases.find((c) => c.id === caseId)!;
  return {
    op: 'automate_case',
    case_id: caseId,
    preserved_manual_expected: c.manual_expected,
    steps: [step('01', caseId === 'C1' ? 'A1' : 'A2', caseId === 'C1' ? '1.250' : '2.500')],
    coverage: [
      {
        obligation_id: caseId === 'C1' ? 'OB1' : 'OB2',
        assertion_ids: [caseId === 'C1' ? 'A1' : 'A2'],
      },
    ],
  };
}

it('converts exactly one case while preserving other cases and shared preparation links', () => {
  const base = baseline(),
    before = structuredClone(base);
  expect(validatePlanStructure(base.plan, urs)).toEqual([]);
  const result = applyPlanEdits(
    base,
    {
      edits: [
        conversion(),
        {
          op: 'add_fixture',
          value: { path: 'fixtures/new.txt', content: 'A derivation retained for review.' },
        },
      ],
    },
    { ...options, automationCaseId: 'C1' },
  );
  expect(result.value.plan.cases[0].manual).toBe(false);
  expect(result.value.plan.cases.slice(1)).toEqual(before.plan.cases.slice(1));
  expect(result.value.plan.questions.find((q) => q.id === 'PREP')?.case_ids).toEqual(['C2']);
  expect(base).toEqual(before);
  expect(validatePlanStructure(result.value.plan, urs)).toEqual([]);
  expect(
    planEditCatalog(base, { ...options, automationCaseId: 'C1' }).automatable_cases.map(
      (c) => c.id,
    ),
  ).toEqual(['C1']);
});

it.each([
  conversion('C2'),
  { op: 'update_instruction', case_id: 'C3', step_id: '01', instruction: 'Changed outside scope.' },
  { op: 'add_question', value: { id: 'NEW-Q', question: 'New manual work?', requirement: 'R1' } },
  {
    op: 'revise_fixture',
    path: 'fixtures/expected.txt',
    content: 'Changed',
    reason: 'Attempted overwrite.',
  },
])('rejects non-target or non-conversion operations in an automation request: $op', (edit) => {
  const base = baseline(),
    before = structuredClone(base);
  expect(() =>
    applyPlanEdits(
      base,
      { edits: [edit] },
      { ...options, automationCaseId: 'C1', allowDraftExpectationRevision: true },
    ),
  ).toThrow(PlanEditError);
  expect(base).toEqual(before);
});

it.each(['openai', 'anthropic'] as const)(
  '%s native contracts constrain both automation and general case targets',
  (provider) => {
    const base = baseline();
    const single = compileStructuredOutput(
      makePlanEditsSchema(base, { ...options, automationCaseId: 'C1' }),
      provider,
    );
    expect(
      single.decode(single.wireSchema.parse(single.encode({ edits: [conversion()] }))),
    ).toMatchObject({ edits: [{ case_id: 'C1' }] });
    expect(
      makePlanEditsSchema(base, { ...options, automationCaseId: 'C1' }).safeParse({
        edits: [conversion('C2')],
      }).success,
    ).toBe(false);
    const scoped = makePlanEditsSchema(base, { ...options, scopedCaseIds: ['C3'] });
    expect(
      scoped.safeParse({
        edits: [
          {
            op: 'update_assertion_locator',
            assertion_id: 'A4',
            locator: { by: 'testId', value: 'elsewhere' },
          },
        ],
      }).success,
    ).toBe(false);
    expect(() => compileStructuredOutput(scoped, provider)).not.toThrow();
  },
);

it('allows complete new coverage only within the selected requirements', () => {
  const base = baseline(),
    before = structuredClone(base);
  const added = {
    ...structuredClone(base.plan.cases[2]),
    id: 'C5',
    actor: undefined,
    steps: [step('01', 'A5')],
  };
  const result = applyPlanEdits(
    base,
    {
      edits: [
        {
          op: 'update_instruction',
          case_id: 'C3',
          step_id: '01',
          instruction: 'Read the reviewed first value.',
        },
        { op: 'add_case', value: added },
        {
          op: 'extend_obligation',
          obligation_id: 'OB1',
          assertion_ids: ['A5'],
          manual_case_ids: [],
        },
      ],
    },
    { ...options, scopedCaseIds: ['C3'] },
  );
  expect(result.value.plan.cases.find((c) => c.id === 'C5')?.requirements).toEqual(['R1']);
  expect(result.value.plan.cases[0]).toEqual(before.plan.cases[0]);
  expect(result.value.plan.cases[1]).toEqual(before.plan.cases[1]);
  expect(result.value.plan.cases[3]).toEqual(before.plan.cases[3]);
  expect(base).toEqual(before);
});

it.each([
  {
    op: 'add_case',
    value: { ...baseline().plan.cases[3], id: 'C5', actor: undefined, steps: [step('01', 'A5')] },
  },
  { op: 'extend_obligation', obligation_id: 'OB1', assertion_ids: ['A4'], manual_case_ids: [] },
  { op: 'extend_obligation', obligation_id: 'OB2', assertion_ids: ['A3'], manual_case_ids: [] },
  {
    op: 'add_obligation',
    value: {
      id: 'OB3',
      requirement_id: 'R1',
      source: 'R1/statement',
      statement: 'Improper outside link.',
      assertion_ids: ['A4'],
    },
  },
  { op: 'add_case_requirement', case_id: 'C3', requirement_id: 'R2' },
  {
    op: 'add_question',
    value: { id: 'NEW-Q', question: 'An unrelated question.', requirement: 'R2' },
  },
  { op: 'add_question', value: { id: 'NEW-Q', question: 'An unbound global question.' } },
  {
    op: 'resolve_question',
    question_id: 'Q2',
    supporting_quote: 'Q2 is settled.',
    resolution: 'Settled.',
  },
  { op: 'repair_actor', actor_id: 'SHARED', mode: 'anonymous' },
  { op: 'set_input_declarations', fixtures: [], references: [] },
  {
    op: 'revise_fixture',
    path: 'fixtures/expected.txt',
    content: 'Changed.',
    reason: 'Attempted shared rewrite.',
  },
])('rejects a scoped request that attempts an unrelated or global change: $op', (edit) => {
  const base = baseline(),
    before = structuredClone(base);
  expect(() =>
    applyPlanEdits(
      base,
      { edits: [edit] },
      {
        ...options,
        mode: 'technical',
        allowDraftExpectationRevision: true,
        questionResolutionFeedback: 'Q2 is settled.',
        scopedCaseIds: ['C3'],
      },
    ),
  ).toThrow(PlanEditError);
  expect(base).toEqual(before);
});

it('restricts rehearsal locator repairs to selected cases even with all other permissions enabled', () => {
  const base = baseline();
  const permission = {
    ...options,
    proceduralOnly: true,
    scopedCaseIds: ['C3'],
    allowDraftExpectationRevision: true,
    allowManualExceptions: true,
  };
  const valid = {
    edits: [
      {
        op: 'update_assertion_locator',
        assertion_id: 'A3',
        locator: { by: 'testId', value: 'first-saved' },
      },
    ],
  };
  expect(
    applyPlanEdits(base, valid, permission).value.plan.cases[2].steps[0].assertions[0].locator
      ?.value,
  ).toBe('first-saved');
  expect(() =>
    applyPlanEdits(base, { edits: [{ ...valid.edits[0], assertion_id: 'A4' }] }, permission),
  ).toThrow(PlanEditError);
  expect(() => applyPlanEdits(base, { edits: [conversion()] }, permission)).toThrow(PlanEditError);
});

it.each([{ scopedCaseIds: [] }, { scopedCaseIds: ['MISSING'] }, { scopedCaseIds: ['C3', 'C3'] }])(
  'rejects invalid scopes atomically: %j',
  ({ scopedCaseIds }) => {
    expect(() => makePlanEditsSchema(baseline(), { ...options, scopedCaseIds })).toThrow(
      PlanEditError,
    );
  },
);
