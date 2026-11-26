import { describe, expect, it } from 'vitest';
import { planSchema, ursSchema } from '../src/schema.js';
import { validatePlanStructure } from '../src/compiler.js';
import {
  applyPlanEdits,
  makePlanEditsSchema,
  planEditCatalog,
  PlanEditError,
  type GeneratedPlanDocument,
  type PlanEditOptions,
} from '../src/authoring/plan-edits.js';

const urs = ursSchema.parse({
  schema_version: 1,
  document: { id: 'URS', revision: '1', title: 'Register', intended_use: 'Retain identifiers.' },
  families: [
    {
      id: 'register',
      title: 'Register',
      requirements: [
        { id: 'URS-1', title: 'Entry', statement: 'Show the identifier field.' },
        {
          id: 'URS-2',
          title: 'Persistence',
          statement: 'Retain the saved identifier after browser restart.',
        },
      ],
    },
  ],
});
function baseline(): GeneratedPlanDocument {
  return {
    plan: planSchema.parse({
      schema_version: 1,
      runtime_version: 1,
      id: 'IOQ',
      title: 'Register qualification',
      urs_revision: '1',
      target: { url: 'https://example.test/', allowed_origins: ['https://example.test'] },
      environment: {},
      access: [
        {
          id: 'ACTOR',
          role: 'Public user',
          state: 'signed_out',
          mode: 'anonymous',
          purpose: 'Public access',
          cases: ['OQ-01', 'OQ-04'],
        },
      ],
      obligations: [
        {
          id: 'OB-1',
          requirement_id: 'URS-1',
          source: 'URS-1/statement',
          statement: 'Identifier is visible.',
          assertion_ids: ['A16'],
        },
        {
          id: 'OB-2',
          requirement_id: 'URS-2',
          source: 'URS-2/statement',
          statement: 'Identifier persists.',
          manual_case_ids: ['OQ-04'],
        },
      ],
      cases: [
        {
          id: 'OQ-01',
          title: 'Identifier',
          classification: 'OQ',
          actor: 'ACTOR',
          requirements: ['URS-1'],
          steps: [
            {
              id: 'S1',
              instruction: 'Inspect the identifier field.',
              actions: [
                { op: 'navigate', url: '/' },
                { op: 'click', locator: { by: 'role', role: 'button', value: 'Open' } },
              ],
              assertions: [
                {
                  id: 'A16',
                  locator: { by: 'label', value: 'Identifier' },
                  read: 'visible',
                  comparison: 'equals',
                  expected: true,
                },
              ],
              evidence: [{ id: 'E1', kind: 'screenshot' }],
            },
          ],
        },
        {
          id: 'OQ-04',
          title: 'Restart',
          classification: 'OQ',
          actor: 'ACTOR',
          requirements: ['URS-2'],
          manual: true,
          manual_procedure: 'Save R, restart the browser, and reopen the register.',
          manual_expected: 'R remains, with its exact original values.',
          steps: [],
        },
      ],
      fixtures: ['fixtures/derivation.txt'],
    }),
    fixtures: [{ path: 'fixtures/derivation.txt', content: 'Independent expected result: 1.250.' }],
  };
}
const options: PlanEditOptions = { mode: 'review', urs };
const technical: PlanEditOptions = { mode: 'technical', urs };
const assertion = (id = 'A17') => ({
  id,
  locator: { by: 'label' as const, value: 'Identifier' },
  read: 'value' as const,
  comparison: 'equals' as const,
  expected: '',
});
const step = (id = 'S2', assertionId = 'A17') => ({
  id,
  instruction: 'Verify the initially empty value.',
  actions: [],
  assertions: [assertion(assertionId)],
  evidence: [],
});
function repeatedStepNumbers(): GeneratedPlanDocument {
  const original = baseline();
  original.plan.cases[0].steps[0].id = '01';
  const second = structuredClone(original.plan.cases[0]);
  second.id = 'OQ-02';
  second.steps[0].assertions[0].id = 'A18';
  second.steps[0].evidence[0].id = 'E2';
  original.plan.cases.push(second);
  original.plan.access[0].cases.push(second.id);
  original.plan.obligations[0].assertion_ids.push('A18');
  return original;
}

function conversion() {
  return {
    op: 'automate_case' as const,
    case_id: 'OQ-04',
    preserved_manual_expected: baseline().plan.cases[1].manual_expected!,
    steps: [
      {
        ...step('01', 'AR1'),
        instruction: 'Restart and verify the original identifier.',
        actions: [
          {
            op: 'browser' as const,
            command: 'open_profile' as const,
            name: 'persistent',
            url: '/',
          },
          {
            op: 'fill' as const,
            locator: { by: 'label' as const, value: 'Identifier' },
            value: 'R',
          },
          { op: 'click' as const, locator: { by: 'role' as const, role: 'button', value: 'Save' } },
          { op: 'browser' as const, command: 'restart_profile' as const, name: 'persistent' },
        ],
        assertions: [{ ...assertion('AR1'), expected: 'R' }],
      },
    ],
    coverage: [{ obligation_id: 'OB-2', assertion_ids: ['AR1'] }],
  };
}
const automationOptions = { ...options, allowManualConversion: true };

describe('manual-to-automated protocol conversion', () => {
  it('transfers coverage atomically while retaining identity, manual expectations, and full audit', () => {
    const original = baseline();
    const before = structuredClone(original);
    const result = applyPlanEdits(original, { edits: [conversion()] }, automationOptions);
    expect(original).toEqual(before);
    expect(result.value.plan.cases[1]).toEqual(
      planSchema.shape.cases.element.parse({
        ...before.plan.cases[1],
        manual: false,
        steps: conversion().steps,
      }),
    );
    expect(result.value.plan.obligations[1]).toEqual({
      ...before.plan.obligations[1],
      manual_case_ids: [],
      assertion_ids: ['AR1'],
    });
    expect(result.value.plan.cases[0]).toEqual(before.plan.cases[0]);
    expect(result.value.fixtures).toEqual(before.fixtures);
    expect(result.changes.find((change) => change.target === 'OQ-04')?.before).toEqual(
      before.plan.cases[1],
    );
    expect(validatePlanStructure(result.value.plan, urs)).toEqual([]);
  });
  it('requires explicit conversion permission', () => {
    expect(() => applyPlanEdits(baseline(), { edits: [conversion()] }, options)).toThrow(
      PlanEditError,
    );
    expect(planEditCatalog(baseline(), options).automatable_cases).toEqual([]);
  });
  it.each([
    {
      label: 'changed expected behavior',
      edit: () => ({ ...conversion(), preserved_manual_expected: 'Any record is visible.' }),
      match: 'preserve its original',
    },
    {
      label: 'missing obligation',
      edit: () => ({ ...conversion(), coverage: [] }),
      match: 'every manual obligation',
    },
    {
      label: 'unrelated obligation',
      edit: () => ({
        ...conversion(),
        coverage: [{ obligation_id: 'OB-1', assertion_ids: ['AR1'] }],
      }),
      match: 'every manual obligation',
    },
    {
      label: 'duplicate mapping',
      edit: () => ({
        ...conversion(),
        coverage: [...conversion().coverage, ...conversion().coverage],
      }),
      match: 'Duplicate conversion obligation',
    },
    {
      label: 'old assertion borrowing',
      edit: () => ({
        ...conversion(),
        coverage: [{ obligation_id: 'OB-2', assertion_ids: ['A16'] }],
      }),
      match: 'only new assertions',
    },
    {
      label: 'colliding assertion ID',
      edit: () => ({
        ...conversion(),
        steps: [step('01', 'A16')],
        coverage: [{ obligation_id: 'OB-2', assertion_ids: ['A16'] }],
      }),
      match: 'Duplicate plan ID A16',
    },
  ])('rejects $label without mutating the source', ({ edit, match }) => {
    const original = baseline();
    const before = structuredClone(original);
    expect(() => applyPlanEdits(original, { edits: [edit()] }, automationOptions)).toThrow(match);
    expect(original).toEqual(before);
  });
  it('rejects presence-only substitutes for manual data checks', () => {
    const edit = conversion();
    const weak = {
      ...edit,
      steps: [
        {
          ...step('01', 'AR1'),
          assertions: [
            {
              id: 'AR1',
              locator: { by: 'label', value: 'Identifier' },
              read: 'value',
              comparison: 'present',
            },
          ],
        },
      ],
    };
    expect(() => applyPlanEdits(baseline(), { edits: [weak] }, automationOptions)).toThrow(
      'data predicate',
    );
  });
  it('retains unrelated manual coverage on the same obligation', () => {
    const original = baseline();
    original.plan.cases.push({ ...structuredClone(original.plan.cases[1]), id: 'OQ-05' });
    original.plan.access[0].cases.push('OQ-05');
    original.plan.obligations[1].manual_case_ids.push('OQ-05');
    const result = applyPlanEdits(original, { edits: [conversion()] }, automationOptions);
    expect(result.value.plan.obligations[1].manual_case_ids).toEqual(['OQ-05']);
    expect(result.value.plan.obligations[1].assertion_ids).toEqual(['AR1']);
  });
  it('requires an audited explanation when automation eliminates the last preparation job', () => {
    const original = baseline();
    original.plan.cases[1].prerequisites = ['Prepare a persistent browser profile.'];
    original.plan.questions = [
      {
        id: 'Q-PREP',
        question: 'Prepare a persistent browser profile.',
        kind: 'execution_preparation',
        case_ids: ['OQ-04'],
        requirement: 'URS-2',
      },
    ];
    expect(() => applyPlanEdits(original, { edits: [conversion()] }, automationOptions)).toThrow(
      'explicit preparation resolution',
    );
    const edit = {
      ...conversion(),
      preparation_resolutions: [
        {
          question_id: 'Q-PREP',
          explanation: 'The browser action starts and restarts its own persistent profile.',
        },
      ],
    };
    const result = applyPlanEdits(original, { edits: [edit] }, automationOptions);
    expect(result.value.plan.questions).toEqual([]);
    expect(result.changes.find((change) => change.target === 'Q-PREP')?.before).toEqual(
      original.plan.questions[0],
    );
    expect(result.value.plan.cases[1].prerequisites).toEqual(original.plan.cases[1].prerequisites);
  });
  it('removes only exact prerequisites completed by automation and retains their rationale for review', () => {
    const original = baseline();
    const completed = 'Prepare a disposable persistent browser profile.';
    const retained = 'Use the approved qualification deployment.';
    original.plan.cases[1].prerequisites = [completed, retained];
    const automated_prerequisites = [
      {
        prerequisite: completed,
        explanation:
          'open_profile creates the isolated persistent profile and the test supplies its own synthetic record.',
      },
    ];
    const result = applyPlanEdits(
      original,
      { edits: [{ ...conversion(), automated_prerequisites }] },
      automationOptions,
    );
    expect(result.value.plan.cases[1].prerequisites).toEqual([retained]);
    expect(original.plan.cases[1].prerequisites).toEqual([completed, retained]);
    expect(result.changes.find((change) => change.target === 'OQ-04/prerequisites')).toMatchObject({
      before: [completed, retained],
      after: { prerequisites: [retained], automated_prerequisites },
    });
    expect(result.changes.find((change) => change.target === 'OQ-04')?.before).toEqual(
      original.plan.cases[1],
    );
    expect(planEditCatalog(original, automationOptions).automatable_cases[0].prerequisites).toEqual(
      [completed, retained],
    );
  });
  it.each([
    {
      entries: [{ prerequisite: 'Unknown setup condition.', explanation: 'Already automated.' }],
      message: 'match an existing original prerequisite exactly',
    },
    {
      entries: [{ prerequisite: 'Prepare a profile', explanation: 'Already automated.' }],
      message: 'match an existing original prerequisite exactly',
    },
    {
      entries: [
        { prerequisite: 'Prepare a profile.', explanation: 'Automated.' },
        { prerequisite: 'Prepare a profile.', explanation: 'Also automated.' },
      ],
      message: 'Duplicate automated prerequisites',
    },
    { entries: [{ prerequisite: 'Prepare a profile.', explanation: '' }], message: 'explanation' },
  ])('rejects incomplete or ambiguous prerequisite removal: $message', ({ entries, message }) => {
    const original = baseline();
    original.plan.cases[1].prerequisites = ['Prepare a profile.'];
    const before = structuredClone(original);
    expect(() =>
      applyPlanEdits(
        original,
        { edits: [{ ...conversion(), automated_prerequisites: entries }] },
        automationOptions,
      ),
    ).toThrow(message);
    expect(original).toEqual(before);
  });
  it('does not clear a product decision through preparation resolution', () => {
    const original = baseline();
    original.plan.questions = [
      { id: 'Q-DECISION', question: 'Should the identifier be retained?', requirement: 'URS-2' },
    ];
    const edit = {
      ...conversion(),
      preparation_resolutions: [
        { question_id: 'Q-DECISION', explanation: 'The test makes the decision.' },
      ],
    };
    expect(() => applyPlanEdits(original, { edits: [edit] }, automationOptions)).toThrow(
      'not an original execution-preparation',
    );
  });
  it('keeps shared preparation linked to the remaining manual case', () => {
    const original = baseline();
    original.plan.cases[1].prerequisites = ['Prepare a persistent browser profile.'];
    original.plan.cases.push({ ...structuredClone(original.plan.cases[1]), id: 'OQ-05' });
    original.plan.access[0].cases.push('OQ-05');
    original.plan.questions = [
      {
        id: 'Q-PREP',
        question: 'Prepare a persistent browser profile.',
        kind: 'execution_preparation',
        case_ids: ['OQ-04', 'OQ-05'],
        requirement: 'URS-2',
      },
    ];
    const result = applyPlanEdits(original, { edits: [conversion()] }, automationOptions);
    expect(result.value.plan.questions).toEqual([
      { ...original.plan.questions[0], case_ids: ['OQ-05'] },
    ]);
  });
  it('allows grounded manual justification only with explicit exception permission', () => {
    const manualUrs = structuredClone(urs);
    manualUrs.families[0].requirements[1].details = [
      'A human must perform the physical equipment inspection.',
    ];
    const reason = {
      kind: 'explicit_manual_requirement',
      requirement_id: 'URS-2',
      source: 'URS-2/details/0',
      supporting_quote: manualUrs.families[0].requirements[1].details[0],
      dependency: 'physical equipment inspection',
      explanation: 'The physical item is outside the application.',
    };
    const edit = { op: 'justify_manual_case', case_id: 'OQ-04', reason };
    expect(() =>
      applyPlanEdits(baseline(), { edits: [edit] }, { ...options, urs: manualUrs }),
    ).toThrow(PlanEditError);
    const result = applyPlanEdits(
      baseline(),
      { edits: [edit] },
      { ...options, urs: manualUrs, allowManualExceptions: true },
    );
    expect(result.value.plan.cases[1].manual_reason).toEqual(reason);
    expect(result.value.plan.cases[1].manual_expected).toBe(
      baseline().plan.cases[1].manual_expected,
    );
  });
});

describe('provisional expectation review', () => {
  it('audits fresh draft corrections while preserving fixtures and existing assertions', () => {
    const original = baseline();
    const result = applyPlanEdits(
      original,
      { edits: [{ op: 'revise_assertion', assertion_id: 'A16', expected: false }] },
      { ...options, allowDraftExpectationRevision: true },
    );
    expect(result.value.plan.cases[0].steps[0].assertions[0].expected).toBe(false);
    expect(original.plan.cases[0].steps[0].assertions[0].expected).toBe(true);
    expect(result.value.fixtures).toEqual(original.fixtures);
    expect(result.changes[0].before).toEqual(original.plan.cases[0].steps[0].assertions[0]);
    expect(
      planEditCatalog(original, { ...options, allowDraftExpectationRevision: true })
        .provisional_expectation_revision,
    ).toBe(true);
  });
  it('never enables provisional revisions in technical repair', () => {
    expect(() =>
      applyPlanEdits(
        baseline(),
        { edits: [{ op: 'revise_assertion', assertion_id: 'A16', expected: false }] },
        { ...technical, allowDraftExpectationRevision: true },
      ),
    ).toThrow(PlanEditError);
  });
  it('does not reduce draft data assertions to presence predicates', () => {
    expect(() =>
      applyPlanEdits(
        baseline(),
        { edits: [{ op: 'revise_assertion', assertion_id: 'A16', comparison: 'present' }] },
        { ...options, allowDraftExpectationRevision: true },
      ),
    ).toThrow('presence/absence');
  });
});

describe('post-review procedural repairs', () => {
  const procedural: PlanEditOptions = {
    ...options,
    proceduralOnly: true,
    allowDraftExpectationRevision: true,
    allowManualConversion: true,
    allowManualExceptions: true,
    authorizedRequirementChanges: new Set(['URS-1', 'URS-2']),
  };
  it('allows instruction and locator corrections without changing expected results or coverage', () => {
    const original = baseline();
    const result = applyPlanEdits(
      original,
      {
        edits: [
          {
            op: 'update_instruction',
            case_id: 'OQ-01',
            step_id: 'S1',
            instruction: 'Open the observed identifier form.',
          },
          {
            op: 'update_action_locator',
            case_id: 'OQ-01',
            step_id: 'S1',
            action_index: 1,
            locator: { by: 'role', role: 'button', value: 'Open identifier' },
          },
          {
            op: 'update_assertion_locator',
            assertion_id: 'A16',
            locator: { by: 'label', value: 'Record identifier' },
          },
        ],
      },
      procedural,
    );
    expect(result.value.plan.cases[0].steps[0].assertions[0].expected).toBe(true);
    expect(result.value.plan.obligations).toEqual(original.plan.obligations);
    expect(result.value.fixtures).toEqual(original.fixtures);
    expect(planEditCatalog(original, procedural)).toMatchObject({
      procedural_only: true,
      permitted_operations: [
        'update_instruction',
        'update_action_locator',
        'update_assertion_locator',
      ],
      automatable_cases: [],
      manual_justification_cases: [],
      requirement_revision_cases: [],
      provisional_expectation_revision: false,
    });
  });
  it.each([
    { op: 'revise_assertion', assertion_id: 'A16', expected: false },
    { op: 'revise_manual_expected', case_id: 'OQ-04', expected: 'Any result is acceptable.' },
    { op: 'add_step', case_id: 'OQ-01', value: step() },
    {
      op: 'add_question',
      value: { id: 'Q-NEW', question: 'Accept the observed behavior?', requirement: 'URS-1' },
    },
    {
      op: 'add_fixture',
      value: { path: 'fixtures/new.txt', content: 'Replacement expected result.' },
    },
    {
      op: 'update_action_url',
      case_id: 'OQ-01',
      step_id: 'S1',
      action_index: 0,
      url: '/different-app',
    },
    conversion(),
  ])('rejects $op even if other permissions would allow it', (edit) => {
    expect(() => applyPlanEdits(baseline(), { edits: [edit] }, procedural)).toThrow(PlanEditError);
  });
});

describe('scoped protocol review edits', () => {
  it('adds checks and coverage while preserving A16, manual expectations, and fixtures byte for byte', () => {
    const original = baseline();
    const before = structuredClone(original);
    const result = applyPlanEdits(
      original,
      {
        edits: [
          { op: 'add_step', case_id: 'OQ-01', value: step() },
          { op: 'add_step', case_id: 'OQ-01', value: step('S3', 'A18') },
          {
            op: 'extend_obligation',
            obligation_id: 'OB-1',
            assertion_ids: ['A17', 'A18'],
            manual_case_ids: [],
          },
          {
            op: 'add_fixture',
            value: { path: 'fixtures/additional.txt', content: 'Additional reviewed derivation.' },
          },
        ],
      },
      options,
    );
    expect(original).toEqual(before);
    expect(result.value.plan.cases[0].steps.map((s) => s.id)).toEqual(['S1', 'S2', 'S3']);
    expect(result.value.plan.cases[0].steps[0]).toEqual(before.plan.cases[0].steps[0]);
    expect(result.value.plan.cases[1]).toEqual(before.plan.cases[1]);
    expect(result.value.fixtures[0]).toEqual(before.fixtures[0]);
    expect(result.value.plan.obligations[0].assertion_ids).toEqual(['A16', 'A17', 'A18']);
    expect(validatePlanStructure(result.value.plan, urs)).toEqual([]);
    expect(result.changes).toHaveLength(4);
  });

  it('accepts repeated step numbers in different cases without rewriting the baseline', () => {
    const original = repeatedStepNumbers();
    const before = structuredClone(original);
    const result = applyPlanEdits(original, { edits: [] }, options);
    expect(result.value).toEqual(before);
    expect(result.changes).toEqual([]);
    expect(original).toEqual(before);
  });

  it('keeps instruction and action edits and their audit targets scoped to each case', () => {
    const original = repeatedStepNumbers();
    const before = structuredClone(original);
    const result = applyPlanEdits(
      original,
      {
        edits: ['OQ-01', 'OQ-02'].flatMap((caseId) => [
          {
            op: 'update_instruction',
            case_id: caseId,
            step_id: '01',
            instruction: `Open the form for ${caseId}.`,
          },
          {
            op: 'update_action_url',
            case_id: caseId,
            step_id: '01',
            action_index: 0,
            url: `/${caseId}`,
          },
          {
            op: 'update_action_locator',
            case_id: caseId,
            step_id: '01',
            action_index: 1,
            locator: { by: 'role', role: 'button', value: `Open ${caseId}` },
          },
        ]),
      },
      options,
    );
    for (const caseId of ['OQ-01', 'OQ-02']) {
      const updated = result.value.plan.cases.find((c) => c.id === caseId)!.steps[0];
      const previous = before.plan.cases.find((c) => c.id === caseId)!.steps[0];
      expect(updated.id).toBe('01');
      expect(updated.instruction).toBe(`Open the form for ${caseId}.`);
      expect(updated.actions[0]).toEqual({ op: 'navigate', url: `/${caseId}` });
      expect(updated.actions[1]).toEqual({
        op: 'click',
        locator: { by: 'role', role: 'button', value: `Open ${caseId}`, exact: true },
      });
      expect(updated.assertions).toEqual(previous.assertions);
      expect(updated.evidence).toEqual(previous.evidence);
    }
    expect(result.changes.map((change) => change.target)).toEqual([
      'OQ-01/01',
      'OQ-01/01/0',
      'OQ-01/01/1',
      'OQ-02/01',
      'OQ-02/01/0',
      'OQ-02/01/1',
    ]);
    expect(result.value.plan.obligations).toEqual(before.plan.obligations);
    expect(original).toEqual(before);
  });

  it('adds a case and steps with case-local numbering while retaining global assertion IDs', () => {
    const original = baseline();
    original.plan.cases[0].steps[0].id = '01';
    const extra = structuredClone(original.plan.cases[0]);
    extra.id = 'OQ-02';
    extra.steps[0].assertions[0].id = 'A18';
    extra.steps[0].evidence[0].id = 'E2';
    const result = applyPlanEdits(
      original,
      {
        edits: [
          { op: 'add_case', value: extra },
          { op: 'add_actor_case', actor_id: 'ACTOR', case_id: extra.id },
          { op: 'add_step', case_id: 'OQ-01', after_step_id: '01', value: step('02', 'A19') },
          { op: 'add_step', case_id: 'OQ-02', after_step_id: '01', value: step('02', 'A20') },
          {
            op: 'extend_obligation',
            obligation_id: 'OB-1',
            assertion_ids: ['A18', 'A19', 'A20'],
            manual_case_ids: [],
          },
        ],
      },
      options,
    );
    for (const caseId of ['OQ-01', 'OQ-02'])
      expect(result.value.plan.cases.find((c) => c.id === caseId)!.steps.map((s) => s.id)).toEqual([
        '01',
        '02',
      ]);
    expect(
      result.changes.filter((change) => change.op === 'add_step').map((change) => change.target),
    ).toEqual(['OQ-01/02', 'OQ-02/02']);
    expect(result.value.plan.cases[0].steps[0]).toEqual(original.plan.cases[0].steps[0]);
    expect(result.value.plan.cases[1]).toEqual(original.plan.cases[1]);
    expect(result.value.fixtures).toEqual(original.fixtures);
    expect(validatePlanStructure(result.value.plan, urs)).toEqual([]);
  });

  it.each(['baseline', 'new step', 'new case'])(
    'rejects a duplicated step within one case in %s',
    (kind) => {
      const original = baseline();
      let edits: unknown[] = [];
      if (kind === 'baseline') original.plan.cases[0].steps.push(step('S1'));
      if (kind === 'new step') edits = [{ op: 'add_step', case_id: 'OQ-01', value: step('S1') }];
      if (kind === 'new case') {
        const extra = structuredClone(original.plan.cases[0]);
        extra.id = 'OQ-NEW';
        extra.steps[0].assertions[0].id = 'A18';
        extra.steps[0].evidence[0].id = 'E2';
        extra.steps.push(step('S1'));
        edits = [{ op: 'add_case', value: extra }];
      }
      const before = structuredClone(original);
      expect(() => applyPlanEdits(original, { edits }, options)).toThrow(
        /Duplicate step ID S1 in case OQ-/,
      );
      expect(original).toEqual(before);
    },
  );

  it.each([
    { edits: [{ op: 'delete_assertion', assertion_id: 'A16' }] },
    { edits: [{ op: 'delete_case', case_id: 'OQ-04' }] },
    {
      edits: [
        { op: 'revise_manual_expected', case_id: 'OQ-04', expected: 'A missing R is acceptable.' },
      ],
    },
    { edits: [{ op: 'repair_assertion', assertion_id: 'A16', expected: false }] },
    { plan: baseline().plan, fixtures: [] },
  ])('does not expose removal or expectation replacement in the review schema', (proposal) => {
    const original = baseline();
    expect(makePlanEditsSchema(original, options).safeParse(proposal).success).toBe(false);
    expect(() => applyPlanEdits(original, proposal, options)).toThrow(PlanEditError);
    expect(original).toEqual(baseline());
  });

  it('updates only selected instructions and locator/url bindings', () => {
    const original = baseline();
    const result = applyPlanEdits(
      original,
      {
        edits: [
          {
            op: 'update_instruction',
            case_id: 'OQ-01',
            step_id: 'S1',
            instruction: 'Open the form and inspect its accessible identifier.',
          },
          {
            op: 'update_action_locator',
            case_id: 'OQ-01',
            step_id: 'S1',
            action_index: 1,
            locator: { by: 'role', role: 'button', value: 'Open form' },
          },
          {
            op: 'update_action_url',
            case_id: 'OQ-01',
            step_id: 'S1',
            action_index: 0,
            url: '/form',
          },
          {
            op: 'update_assertion_locator',
            assertion_id: 'A16',
            locator: { by: 'label', value: 'Sample identifier' },
          },
        ],
      },
      options,
    );
    const updated = result.value.plan.cases[0].steps[0];
    expect(updated.assertions[0].expected).toBe(true);
    expect(updated.assertions[0].comparison).toBe('equals');
    expect(updated.assertions[0].id).toBe('A16');
    expect(result.value.plan.cases[1]).toEqual(original.plan.cases[1]);
    expect(result.value.plan.obligations).toEqual(original.plan.obligations);
  });

  it('rejects an extra expected-value field on an otherwise allowed edit', () => {
    expect(() =>
      applyPlanEdits(
        baseline(),
        {
          edits: [
            {
              op: 'update_assertion_locator',
              assertion_id: 'A16',
              locator: { by: 'label', value: 'Identifier' },
              expected: false,
            },
          ],
        },
        options,
      ),
    ).toThrow(PlanEditError);
  });

  it('rejects a later conflict without applying earlier edits to the original', () => {
    const original = baseline();
    expect(() =>
      applyPlanEdits(
        original,
        {
          edits: [
            {
              op: 'update_instruction',
              case_id: 'OQ-01',
              step_id: 'S1',
              instruction: 'First revision.',
            },
            {
              op: 'update_instruction',
              case_id: 'OQ-01',
              step_id: 'S1',
              instruction: 'Conflicting revision.',
            },
          ],
        },
        options,
      ),
    ).toThrow(/Conflicting duplicate/);
    expect(original).toEqual(baseline());
  });

  it('rejects duplicate IDs even when smuggled in a newly added case', () => {
    const extra = structuredClone(baseline().plan.cases[0]);
    extra.id = 'OQ-NEW';
    extra.steps[0].id = 'S-NEW';
    extra.steps[0].evidence[0].id = 'E-NEW';
    expect(() =>
      applyPlanEdits(baseline(), { edits: [{ op: 'add_case', value: extra }] }, options),
    ).toThrow(/Duplicate plan ID A16/);
  });

  it('preserves existing fixture contents and disallows unsafe fixture paths', () => {
    for (const path of ['fixtures/derivation.txt', '../outside.txt', 'fixtures/run.js'])
      expect(() =>
        applyPlanEdits(
          baseline(),
          { edits: [{ op: 'add_fixture', value: { path, content: 'Replacement' } }] },
          options,
        ),
      ).toThrow(PlanEditError);
  });

  it('rejects unknown targets and cannot bind a navigation action as a locator', () => {
    for (const edit of [
      { op: 'update_instruction', case_id: 'missing', step_id: 'S1', instruction: 'Changed' },
      {
        op: 'update_action_locator',
        case_id: 'OQ-01',
        step_id: 'S1',
        action_index: 0,
        locator: { by: 'text', value: 'Open' },
      },
    ])
      expect(() => applyPlanEdits(baseline(), { edits: [edit] }, options)).toThrow(PlanEditError);
  });

  it('rejects new broken coverage links atomically while preserving the original', () => {
    const original = baseline();
    expect(() =>
      applyPlanEdits(
        original,
        {
          edits: [
            {
              op: 'update_instruction',
              case_id: 'OQ-01',
              step_id: 'S1',
              instruction: 'A legitimate clarification.',
            },
            {
              op: 'extend_obligation',
              obligation_id: 'OB-1',
              assertion_ids: ['missing-assertion'],
              manual_case_ids: [],
            },
          ],
        },
        options,
      ),
    ).toThrow(/does not cover its requirement/);
    expect(original).toEqual(baseline());
  });

  it('requires a newly added case and its actor/coverage links to be complete together', () => {
    const original = baseline();
    const extra = structuredClone(original.plan.cases[0]);
    extra.id = 'OQ-NEW';
    extra.steps = [step('S-NEW', 'A-NEW')];
    expect(() =>
      applyPlanEdits(original, { edits: [{ op: 'add_case', value: extra }] }, options),
    ).toThrow(/access inventory omits/);
    const complete = applyPlanEdits(
      original,
      {
        edits: [
          { op: 'add_case', value: extra },
          { op: 'add_actor_case', actor_id: 'ACTOR', case_id: 'OQ-NEW' },
          {
            op: 'extend_obligation',
            obligation_id: 'OB-1',
            assertion_ids: ['A-NEW'],
            manual_case_ids: [],
          },
        ],
      },
      options,
    );
    expect(validatePlanStructure(complete.value.plan, urs)).toEqual([]);
  });
});

describe('diagnosed technical edits', () => {
  it('repairs malformed draft predicates but leaves all other checks intact', () => {
    const original = baseline();
    original.plan.cases[0].steps[0].assertions.push({
      ...assertion(),
      comparison: 'matches',
      expected: '(?:required|missing)',
    });
    const result = applyPlanEdits(
      original,
      {
        edits: [
          {
            op: 'repair_assertion',
            assertion_id: 'A17',
            comparison: 'contains_any',
            expected: ['required', 'missing'],
          },
        ],
      },
      technical,
    );
    expect(result.value.plan.cases[0].steps[0].assertions[1].expected).toEqual([
      'required',
      'missing',
    ]);
    expect(result.value.plan.cases[0].steps[0].assertions[0]).toEqual(
      original.plan.cases[0].steps[0].assertions[0],
    );
    expect(original.plan.cases[0].steps[0].assertions[1].comparison).toBe('matches');
  });

  it('limits a missing tolerance repair to tolerance and retains precise rejected differences', () => {
    const original = baseline();
    const a = original.plan.cases[0].steps[0].assertions[0];
    a.comparison = 'numeric';
    a.expected = 1.25;
    let failure: unknown;
    try {
      applyPlanEdits(
        original,
        {
          edits: [
            { op: 'repair_assertion', assertion_id: 'A16', expected: 9.99, tolerance: 0.001 },
          ],
        },
        technical,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PlanEditError);
    expect((failure as PlanEditError).issues[0]).toMatchObject({
      path: ['edits', 0, 'expected'],
      code: 'protected_expectation',
      before: 1.25,
      proposed: 9.99,
    });
    const result = applyPlanEdits(
      original,
      { edits: [{ op: 'repair_assertion', assertion_id: 'A16', tolerance: 0.001 }] },
      technical,
    );
    expect(result.value.plan.cases[0].steps[0].assertions[0].expected).toBe(1.25);
    expect(result.value.plan.cases[0].steps[0].assertions[0].tolerance).toBe(0.001);
  });

  it('does not let supplied repair permissions broaden the diagnosed fields', () => {
    const original = baseline();
    expect(() =>
      applyPlanEdits(
        original,
        { edits: [{ op: 'repair_assertion', assertion_id: 'A16', expected: false }] },
        { ...technical, repairableAssertionFields: new Map([['A16', new Set(['expected'])]]) },
      ),
    ).toThrow(/no diagnosed/);
  });

  it('can narrow diagnosed repairs and rejects presence/absence substitutions', () => {
    const original = baseline();
    original.plan.cases[0].steps[0].assertions[0].comparison = 'matches';
    original.plan.cases[0].steps[0].assertions[0].expected = '(?:visible|shown)';
    expect(() =>
      applyPlanEdits(
        original,
        { edits: [{ op: 'repair_assertion', assertion_id: 'A16', comparison: 'present' }] },
        technical,
      ),
    ).toThrow(/presence/);
    expect(() =>
      applyPlanEdits(
        original,
        {
          edits: [
            {
              op: 'repair_assertion',
              assertion_id: 'A16',
              comparison: 'contains_any',
              expected: ['visible', 'shown'],
            },
          ],
        },
        { ...technical, repairableAssertionFields: new Map() },
      ),
    ).toThrow(/no diagnosed/);
  });

  it('repairs invalid source and file declarations while preserving the actual input bytes', () => {
    const original = baseline();
    original.plan.obligations[0].source = 'The field requirement above';
    original.plan.references = ['URS title, not a filename'];
    const result = applyPlanEdits(
      original,
      {
        edits: [
          { op: 'repair_obligation_source', obligation_id: 'OB-1', source: 'URS-1/statement' },
          { op: 'set_input_declarations', fixtures: ['fixtures/derivation.txt'], references: [] },
        ],
      },
      technical,
    );
    expect(result.value.plan.obligations[0].source).toBe('URS-1/statement');
    expect(result.value.plan.references).toEqual([]);
    expect(result.value.fixtures).toEqual(original.fixtures);
    expect(() =>
      applyPlanEdits(
        result.value,
        { edits: [{ op: 'set_input_declarations', fixtures: [], references: [] }] },
        technical,
      ),
    ).toThrow(/protected/);
  });

  it('never removes a required normative reference while repairing malformed declarations', () => {
    const reviewed = structuredClone(urs);
    reviewed.families[0].requirements[0].references = ['references/approved.csv'];
    const original = baseline();
    original.plan.references = ['Prose filename'];
    expect(() =>
      applyPlanEdits(
        original,
        {
          edits: [
            { op: 'set_input_declarations', fixtures: ['fixtures/derivation.txt'], references: [] },
          ],
        },
        { ...technical, urs: reviewed },
      ),
    ).toThrow(/normative references/);
  });

  it('removes only diagnosed runtime-format questions, preserving genuine user decisions', () => {
    const original = baseline();
    original.plan.questions = [
      {
        id: 'Q-FORMAT',
        requirement: 'runtime',
        question: 'Which source binding syntax does the runtime accept?',
      },
      {
        id: 'Q-PRODUCT',
        requirement: 'URS-1',
        question: 'Should the field be visible to anonymous users?',
      },
    ];
    const result = applyPlanEdits(
      original,
      { edits: [{ op: 'remove_technical_question', question_id: 'Q-FORMAT' }] },
      technical,
    );
    expect(result.value.plan.questions).toEqual([original.plan.questions[1]]);
    expect(() =>
      applyPlanEdits(
        original,
        { edits: [{ op: 'remove_technical_question', question_id: 'Q-PRODUCT' }] },
        technical,
      ),
    ).toThrow(/not a diagnosed/);
  });

  it('repairs actor syntax without exposing role or purpose replacements', () => {
    const original = baseline();
    original.plan.access[0].state = 'active';
    const result = applyPlanEdits(
      original,
      {
        edits: [{ op: 'repair_actor', actor_id: 'ACTOR', state: 'signed_out', mode: 'anonymous' }],
      },
      technical,
    );
    expect(result.value.plan.access[0]).toEqual(baseline().plan.access[0]);
    expect(() =>
      applyPlanEdits(
        result.value,
        {
          edits: [{ op: 'repair_actor', actor_id: 'ACTOR', state: 'active', mode: 'credentials' }],
        },
        technical,
      ),
    ).toThrow(/protected access/);
  });
});

describe('explicit requirement revisions', () => {
  it('allows an expected-value revision only for the explicitly changed linked requirement', () => {
    const original = baseline();
    const authorized = { ...options, authorizedRequirementChanges: new Set(['URS-1']) };
    const result = applyPlanEdits(
      original,
      { edits: [{ op: 'revise_assertion', assertion_id: 'A16', expected: false }] },
      authorized,
    );
    expect(result.value.plan.cases[0].steps[0].assertions[0].expected).toBe(false);
    expect(result.value.plan.cases[1]).toEqual(original.plan.cases[1]);
    expect(() =>
      applyPlanEdits(
        original,
        {
          edits: [
            { op: 'revise_manual_expected', case_id: 'OQ-04', expected: 'Different result.' },
          ],
        },
        authorized,
      ),
    ).toThrow(/protected by unchanged/);
  });

  it('requires every linked requirement to authorize a shared assertion revision', () => {
    const original = baseline();
    original.plan.cases[0].requirements.push('URS-2');
    const proposal = { edits: [{ op: 'revise_assertion', assertion_id: 'A16', expected: false }] };
    expect(() =>
      applyPlanEdits(original, proposal, {
        ...options,
        authorizedRequirementChanges: new Set(['URS-1']),
      }),
    ).toThrow(PlanEditError);
    expect(
      applyPlanEdits(original, proposal, {
        ...options,
        authorizedRequirementChanges: new Set(['URS-1', 'URS-2']),
      }).value.plan.cases[0].steps[0].assertions[0].expected,
    ).toBe(false);
  });

  it('changes manual expectations only with a changed linked URS and keeps case identity/procedure', () => {
    const original = baseline();
    const result = applyPlanEdits(
      original,
      {
        edits: [
          {
            op: 'revise_manual_expected',
            case_id: 'OQ-04',
            expected: 'R is intentionally cleared on browser restart.',
          },
        ],
      },
      { ...options, authorizedRequirementChanges: new Set(['URS-2']) },
    );
    expect(result.value.plan.cases[1].manual_expected).toContain('intentionally cleared');
    expect(result.value.plan.cases[1].manual_procedure).toBe(
      original.plan.cases[1].manual_procedure,
    );
    expect(result.value.plan.cases[1].id).toBe('OQ-04');
  });

  it('provides only precise diagnosed repair targets to the authoring prompt', () => {
    const original = baseline();
    original.plan.cases[0].steps[0].assertions[0].comparison = 'numeric';
    original.plan.cases[0].steps[0].assertions[0].expected = 1.25;
    expect(planEditCatalog(original, technical).repairable_assertions).toEqual([
      { id: 'A16', fields: ['tolerance'] },
    ]);
    expect(planEditCatalog(original, options).repairable_assertions).toEqual([]);
  });
});

describe('explicit human resolution of protocol questions', () => {
  const question = {
    id: 'IOQ-Q-1',
    question: 'Who prepares and independently reviews this qualification?',
  };
  const otherQuestion = {
    id: 'IOQ-Q-2',
    question: 'Where will the qualification evidence be retained?',
  };
  const supportingQuote = 'Alex prepares it; Sam independently reviews it.';
  const feedback = `${question.id}: ${supportingQuote}`;
  const proposal = {
    edits: [
      {
        op: 'resolve_question',
        question_id: question.id,
        supporting_quote: supportingQuote,
        resolution: supportingQuote,
      },
    ],
  };
  const withQuestions = () => {
    const original = baseline();
    original.plan.questions = [structuredClone(question), structuredClone(otherQuestion)];
    return original;
  };

  it('resolves a named IOQ-only question while retaining its original text, answer, and evidence', () => {
    const original = withQuestions();
    const before = structuredClone(original);
    const result = applyPlanEdits(original, proposal, {
      ...options,
      questionResolutionFeedback: feedback,
    });
    expect(result.value.plan.questions).toEqual([otherQuestion]);
    expect(result.changes).toEqual([
      {
        op: 'resolve_question',
        target: question.id,
        before: question,
        after: {
          question_id: question.id,
          resolution: supportingQuote,
          supporting_quote: supportingQuote,
        },
      },
    ]);
    expect(result.value.plan.cases).toEqual(before.plan.cases);
    expect(result.value.plan.obligations).toEqual(before.plan.obligations);
    expect(result.value.fixtures).toEqual(before.fixtures);
    expect(original).toEqual(before);
  });

  it.each([undefined, '', 'Review the qualification.', 'IOQ-Q-10: Alex prepares it.'])(
    'does not expose resolution without an exact named question token in feedback %s',
    (questionResolutionFeedback) => {
      const original = withQuestions();
      const unauthorized = { ...options, questionResolutionFeedback };
      expect(makePlanEditsSchema(original, unauthorized).safeParse(proposal).success).toBe(false);
      expect(planEditCatalog(original, unauthorized).resolvable_questions).toEqual([]);
      expect(() => applyPlanEdits(original, proposal, unauthorized)).toThrow(PlanEditError);
      expect(original).toEqual(withQuestions());
    },
  );

  it('limits the schema and catalog to known IDs explicitly named in feedback', () => {
    const original = withQuestions();
    const authorized = { ...options, questionResolutionFeedback: feedback };
    const unrelated = {
      edits: [{ ...proposal.edits[0], question_id: otherQuestion.id }],
    };
    expect(makePlanEditsSchema(original, authorized).safeParse(proposal).success).toBe(true);
    expect(makePlanEditsSchema(original, authorized).safeParse(unrelated).success).toBe(false);
    expect(planEditCatalog(original, authorized).resolvable_questions).toEqual([
      { id: question.id, question: question.question, requirement: undefined },
    ]);
    expect(() => applyPlanEdits(original, unrelated, authorized)).toThrow(PlanEditError);
  });

  it('rejects invented or blank supporting quotes atomically', () => {
    const original = withQuestions();
    for (const quote of ['Pat approves this qualification.', '   ']) {
      expect(() =>
        applyPlanEdits(
          original,
          { edits: [{ ...proposal.edits[0], supporting_quote: quote }] },
          { ...options, questionResolutionFeedback: feedback },
        ),
      ).toThrow(PlanEditError);
      expect(original).toEqual(withQuestions());
    }
  });

  it('rejects duplicate resolutions and expectation changes in a resolution proposal', () => {
    const original = withQuestions();
    const authorized = { ...options, questionResolutionFeedback: feedback };
    expect(() =>
      applyPlanEdits(original, { edits: [...proposal.edits, ...proposal.edits] }, authorized),
    ).toThrow(/Conflicting duplicate edit/);
    expect(() =>
      applyPlanEdits(
        original,
        {
          edits: [
            ...proposal.edits,
            { op: 'revise_assertion', assertion_id: 'A16', expected: false },
          ],
        },
        authorized,
      ),
    ).toThrow(PlanEditError);
    expect(original).toEqual(withQuestions());
  });
});

describe('reviewed execution preparation for manual cases', () => {
  const question = {
    id: 'Q-RESTART-SETUP',
    question: 'Which persistent browser profile will be used for restart testing?',
    requirement: 'URS-2',
  };
  const feedback =
    'Q-RESTART-SETUP: Retain the need for a persistent profile as preparation for OQ-04; the required persistence behavior is already defined.';
  const proposal = {
    edits: [
      {
        op: 'reclassify_question_as_preparation',
        question_id: question.id,
        case_ids: ['OQ-04'],
        supporting_quote: feedback,
        resolution: 'Record the profile before executing the manual restart test.',
      },
    ],
  };
  const withPreparation = () => {
    const original = baseline();
    original.plan.cases[1].prerequisites = ['Use a disposable persistent browser profile.'];
    original.plan.questions = [structuredClone(question)];
    return original;
  };
  const reviewed = { ...options, questionResolutionFeedback: feedback };

  it('retains the full question and audit quote without changing expectations or coverage', () => {
    const original = withPreparation();
    const before = structuredClone(original);
    const result = applyPlanEdits(original, proposal, reviewed);
    const classified = { ...question, kind: 'execution_preparation', case_ids: ['OQ-04'] };
    expect(result.value.plan.questions).toEqual([classified]);
    expect(result.changes).toEqual([
      {
        op: 'reclassify_question_as_preparation',
        target: question.id,
        before: question,
        after: {
          question: classified,
          resolution: proposal.edits[0].resolution,
          supporting_quote: feedback,
        },
      },
    ]);
    expect(result.value.plan.cases).toEqual(before.plan.cases);
    expect(result.value.plan.obligations).toEqual(before.plan.obligations);
    expect(result.value.fixtures).toEqual(before.fixtures);
    expect(original).toEqual(before);
    expect(validatePlanStructure(result.value.plan, urs)).toEqual([]);
    expect(planEditCatalog(original, reviewed).preparation_questions).toEqual([
      {
        ...question,
        manual_case_ids: ['OQ-04'],
      },
    ]);
  });

  it.each([undefined, '', 'Review all questions.', 'Q-RESTART-SETUP-2: Treat as preparation.'])(
    'requires explicit human feedback naming the exact question: %s',
    (questionResolutionFeedback) => {
      const original = withPreparation();
      const unauthorized = { ...options, questionResolutionFeedback };
      expect(makePlanEditsSchema(original, unauthorized).safeParse(proposal).success).toBe(false);
      expect(planEditCatalog(original, unauthorized).preparation_questions).toEqual([]);
      expect(() => applyPlanEdits(original, proposal, unauthorized)).toThrow(PlanEditError);
      expect(original).toEqual(withPreparation());
    },
  );

  it('rejects an invented supporting quote', () => {
    const original = withPreparation();
    expect(() =>
      applyPlanEdits(
        original,
        {
          edits: [{ ...proposal.edits[0], supporting_quote: 'The profile has been supplied.' }],
        },
        reviewed,
      ),
    ).toThrow(/supporting quote must occur exactly/);
    expect(original).toEqual(withPreparation());
  });

  it.each([[], ['missing'], ['OQ-01'], ['OQ-04', 'OQ-04']])(
    'rejects missing, unknown, automated, or duplicate manual case links %j',
    (case_ids) => {
      const original = withPreparation();
      expect(() =>
        applyPlanEdits(
          original,
          {
            edits: [{ ...proposal.edits[0], case_ids }],
          },
          reviewed,
        ),
      ).toThrow(PlanEditError);
      expect(original).toEqual(withPreparation());
    },
  );

  it('does not expose reclassification when the existing manual case lacks a defined test or prerequisite', () => {
    for (const field of [
      'prerequisites',
      'manual_procedure',
      'manual_expected',
      'requirements',
    ] as const) {
      const original = withPreparation();
      if (field === 'prerequisites' || field === 'requirements') original.plan.cases[1][field] = [];
      else original.plan.cases[1][field] = '';
      expect(makePlanEditsSchema(original, reviewed).safeParse(proposal).success).toBe(false);
      expect(planEditCatalog(original, reviewed).preparation_questions).toEqual([]);
      expect(() => applyPlanEdits(original, proposal, reviewed)).toThrow(PlanEditError);
    }
  });

  it('accepts new typed preparation questions only when their affected cases validate', () => {
    const original = withPreparation();
    original.plan.questions = [];
    const value = { ...question, kind: 'execution_preparation', case_ids: ['OQ-04'] };
    const result = applyPlanEdits(original, { edits: [{ op: 'add_question', value }] }, options);
    expect(result.value.plan.questions).toEqual([value]);
    expect(() =>
      applyPlanEdits(
        original,
        {
          edits: [{ op: 'add_question', value: { ...value, case_ids: ['OQ-01'] } }],
        },
        options,
      ),
    ).toThrow(PlanEditError);
  });

  it('rejects conflicting classification and any accompanying expected-result change atomically', () => {
    const original = withPreparation();
    expect(() =>
      applyPlanEdits(original, { edits: [...proposal.edits, ...proposal.edits] }, reviewed),
    ).toThrow(/Conflicting duplicate edit/);
    expect(() =>
      applyPlanEdits(
        original,
        {
          edits: [
            ...proposal.edits,
            {
              op: 'revise_manual_expected',
              case_id: 'OQ-04',
              expected: 'Any record is acceptable.',
            },
          ],
        },
        reviewed,
      ),
    ).toThrow(PlanEditError);
    expect(original).toEqual(withPreparation());
  });
});
