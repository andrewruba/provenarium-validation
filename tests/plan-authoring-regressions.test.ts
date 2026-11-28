import { providerOutputText } from './provider-fixture.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generatePlan } from '../src/authoring/index.js';
import { assertionSchema, planSchema, ursSchema } from '../src/schema.js';

vi.mock('../src/authoring/discovery.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/authoring/discovery.js')>();
  return {
    ...original,
    Discovery: class {
      async open() {
        return {
          url: 'https://example.test/',
          title: 'Synthetic register',
          text: 'Sample ID',
          controls: [{ label: 'Sample ID', type: 'text' }],
          links: [],
        };
      }
      async close() {}
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const urs = ursSchema.parse({
  schema_version: 1,
  document: {
    id: 'URS-SYNTHETIC',
    revision: '1',
    title: 'Synthetic register',
    intended_use: 'Record synthetic sample identifiers.',
  },
  families: [
    {
      id: 'entry',
      title: 'Entry',
      requirements: [
        {
          id: 'URS-001',
          title: 'Sample identifier',
          statement: 'The form shall show a labeled Sample ID entry.',
          details: ['The field shall initially be blank.'],
        },
      ],
    },
  ],
});

function candidate() {
  return {
    plan: planSchema.parse({
      schema_version: 1,
      runtime_version: 1,
      id: 'PLAN-SYNTHETIC',
      title: 'Synthetic register protocol',
      urs_revision: '1',
      target: { url: 'https://example.test/', allowed_origins: ['https://example.test'] },
      environment: {},
      obligations: [
        {
          id: 'OB-01',
          requirement_id: 'URS-001',
          source: 'URS-001/statement',
          statement: 'Sample ID is shown.',
          assertion_ids: ['A-01'],
        },
      ],
      cases: [
        {
          id: 'IQ-01',
          title: 'Entry field',
          classification: 'IQ',
          requirements: ['URS-001'],
          steps: [
            {
              id: 'S-01',
              instruction: 'Open the form and verify its field.',
              actions: [{ op: 'navigate', url: '/' }],
              assertions: [
                {
                  id: 'A-01',
                  locator: { by: 'label', value: 'Sample ID' },
                  read: 'visible',
                  comparison: 'equals',
                  expected: true,
                },
              ],
              evidence: [{ id: 'E-01', kind: 'observation' }],
            },
          ],
        },
      ],
    }),
    fixtures: [],
  };
}

function transport(values: unknown[]) {
  return vi.fn(async (_url: unknown, _options?: RequestInit) => {
    const next = values.shift();
    if (next === undefined) throw new Error('Unexpected additional authoring request.');
    return new Response(
      JSON.stringify({
        status: 'completed',
        usage: { input_tokens: 100, output_tokens: 50 },
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: providerOutputText(_options, next) }],
          },
        ],
      }),
    );
  });
}

async function run(values: unknown[], options: { urs?: typeof urs } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'provenarium-plan-authoring-'));
  roots.push(root);
  const fetchImpl = transport(values);
  const result = await generatePlan({
    root,
    provider: 'openai',
    key: 'synthetic-key',
    urs,
    url: 'https://example.test/',
    thoroughness: 'quick',
    context: { passages: [], hashes: [], warnings: [] },
    ...options,
    fetchImpl,
  });
  return { result, fetchImpl };
}

function requestBody(fetchImpl: ReturnType<typeof transport>, index: number) {
  return JSON.parse(String(fetchImpl.mock.calls[index][1]?.body));
}

function malformedPredicates() {
  const generated = candidate();
  const step = generated.plan.cases[0].steps[0];
  step.actions.push({
    op: 'download',
    locator: { by: 'role', role: 'link', value: 'Export', exact: true },
    save_as: 'export',
  });
  step.assertions.push(
    assertionSchema.parse({
      id: 'A-CSV',
      variable: 'export.text',
      comparison: 'matches',
      expected: '^' + 'Sample ID,Volume\\r?\\n'.repeat(15) + '$',
    }),
    assertionSchema.parse({
      id: 'A-TEXT',
      locator: { by: 'label', value: 'Validation message' },
      comparison: 'matches',
      expected: '(?:required|missing)',
    }),
  );
  generated.plan.obligations[0].assertion_ids.push('A-CSV', 'A-TEXT');
  return generated;
}

function correctedPredicates() {
  const generated = malformedPredicates();
  const [, csv, text] = generated.plan.cases[0].steps[0].assertions;
  csv.comparison = 'csv_equals';
  csv.expected = [
    ['Sample ID', 'Volume'],
    ['SYNTHETIC-1', '1.250'],
  ];
  text.comparison = 'contains_any';
  text.expected = ['required', 'missing'];
  return generated;
}

function sourceEdits() {
  return {
    edits: [
      { op: 'repair_obligation_source', obligation_id: 'OB-01', source: 'URS-001/statement' },
      { op: 'set_input_declarations', fixtures: [], references: [] },
    ],
  };
}
function predicateEdits() {
  const [, csv, text] = correctedPredicates().plan.cases[0].steps[0].assertions;
  return {
    edits: [
      {
        op: 'repair_assertion',
        assertion_id: 'A-CSV',
        comparison: csv.comparison,
        expected: csv.expected,
      },
      {
        op: 'repair_assertion',
        assertion_id: 'A-TEXT',
        comparison: text.comparison,
        expected: text.expected,
      },
    ],
  };
}

it('supplies exact source bindings and runtime rules and normalizes an unambiguous local source', async () => {
  const generated = candidate();
  generated.plan.obligations[0].source = 'statement';
  const { result, fetchImpl } = await run([generated]);

  expect(result.incomplete).toBe(false);
  expect(result.value?.plan.obligations[0].source).toBe('URS-001/statement');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const input = JSON.parse(requestBody(fetchImpl, 0).input[0].content[0].text);
  expect(JSON.stringify(input.obligation_sources)).toContain('URS-001/statement');
  expect(JSON.stringify(input.obligation_sources)).toContain('URS-001/details/0');
  expect(input.available_reference_files).toEqual([]);
  expect(input.runtime_contract).toHaveProperty('source_syntax');
  expect(input.runtime_contract.locator_syntax).toContain('match: text');
  expect(input.runtime_contract.navigation).toContain('Do not use about:blank');
  expect(input.runtime_contract.submission_checks).toContain('identifies the submitted record');
  expect(input.runtime_contract).toHaveProperty('anonymous_access');
  expect(input.runtime_contract).toHaveProperty('artifact_rules');
});

it('repairs a blank navigation using the approved entry document in one authoring request', async () => {
  const generated = candidate();
  const step = generated.plan.cases[0].steps[0];
  const assertions = structuredClone(step.assertions);
  step.actions = [
    { op: 'navigate', url: 'about:blank' },
    { op: 'navigate', url: '/?workspace=cleared#records' },
  ];
  generated.plan.target = {
    url: 'https://outside.test/',
    allowed_origins: ['https://outside.test'],
  };
  const { result, fetchImpl } = await run([generated]);

  expect(result.incomplete).toBe(false);
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(result.value?.plan.target).toEqual({
    url: 'https://example.test/',
    allowed_origins: ['https://example.test'],
  });
  expect(result.value?.plan.cases[0].steps[0].actions).toEqual([
    { op: 'navigate', url: 'https://example.test/' },
    { op: 'navigate', url: '/?workspace=cleared#records' },
  ]);
  expect(result.value?.plan.cases[0].steps[0].assertions).toEqual(assertions);
});

it.each([
  ['a fragment change within the entry document', '/#records'],
  ['a different origin', 'https://outside.test/records'],
  ['an authentication query parameter', '/?token=synthetic-token'],
])('rejects a blank navigation followed by %s', async (_scenario, url) => {
  const generated = candidate();
  generated.plan.cases[0].steps[0].actions = [
    { op: 'navigate', url: 'about:blank' },
    { op: 'navigate', url },
  ];
  const { result } = await run([generated]);

  expect(result.incomplete).toBe(true);
  expect(result.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'document_structure',
        issues: expect.arrayContaining([
          expect.objectContaining({ message: expect.stringContaining('IQ-01/S-01') }),
        ]),
      }),
    ]),
  );
});

it('repairs invalid source bindings and prose references using validator feedback before review', async () => {
  const malformed = candidate();
  malformed.plan.obligations[0].source = 'The form requirement above';
  malformed.plan.references = ['URS-SYNTHETIC, Draft 1, including accepted human resolutions.'];
  const corrected = candidate();
  const { result, fetchImpl } = await run([malformed, sourceEdits()]);

  expect(result.incomplete).toBe(false);
  expect(result.value?.plan.references).toEqual([]);
  expect(result.value?.plan.obligations[0].source).toBe('URS-001/statement');
  expect(result.value?.plan.cases[0].steps[0].assertions).toEqual(
    corrected.plan.cases[0].steps[0].assertions,
  );
  const repair = JSON.parse(requestBody(fetchImpl, 1).input[0].content[0].text);
  expect(repair.candidate.plan.references).toEqual(malformed.plan.references);
  expect(repair.validation_errors.join('\n')).toMatch(/source/i);
  expect(repair.validation_errors.join('\n')).toContain(malformed.plan.references[0]);
  expect(JSON.stringify(repair.obligation_sources)).toContain('URS-001/statement');
  expect(repair.available_reference_files).toEqual([]);
});

it('retains an incomplete diagnostic after two unsuccessful technical corrections', async () => {
  const malformed = candidate();
  malformed.plan.obligations[0].source = 'Unknown reviewed clause';
  malformed.plan.references = ['Missing external review assignment and attachment.'];
  const { result, fetchImpl } = await run([malformed, { edits: [] }, { edits: [] }]);

  expect(result.incomplete).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(result.questions.join('\n')).toMatch(/source|reference/i);
  expect(result.spend.calls).toBe(3);
});

it('does not weaken an expected outcome to get a technical correction through validation', async () => {
  const malformed = candidate();
  malformed.plan.obligations[0].source = 'Unbound clause';
  const weakened = {
    edits: [
      ...sourceEdits().edits,
      { op: 'repair_assertion', assertion_id: 'A-01', expected: false },
    ],
  };
  const { result } = await run([malformed, weakened, weakened]);

  expect(result.incomplete).toBe(true);
  expect(result.questions.join('\n')).toMatch(/expected|protect|repair|A-01/i);
  expect(result.value?.plan.cases[0].steps[0].assertions[0].expected).toBe(true);
});

it('repairs a runtime-compatibility question instead of treating it as a user requirement decision', async () => {
  const malformed = candidate();
  malformed.plan.questions = [
    {
      id: 'IOQ-Q-RUNTIME',
      requirement: 'Plan runtime compatibility',
      question: 'What source-reference syntax does runtime version 1 accept?',
    },
  ];
  const { result, fetchImpl } = await run([
    malformed,
    { edits: [{ op: 'remove_technical_question', question_id: 'IOQ-Q-RUNTIME' }] },
  ]);

  expect(result.incomplete).toBe(false);
  expect(result.value?.plan.questions).toEqual([]);
  const correction = JSON.parse(requestBody(fetchImpl, 1).input[0].content[0].text);
  expect(correction.validation_errors.join('\n')).toMatch(/existing URS requirement/i);
  expect(correction.runtime_contract).toHaveProperty('source_syntax');
});

it('keeps a genuine product question as an approval blocker without treating it as malformed output', async () => {
  const generated = candidate();
  generated.plan.questions = [
    {
      id: 'Q-VISIBILITY',
      requirement: 'URS-001',
      question: 'Should inactive users also be able to see the Sample ID field?',
    },
  ];
  const { result, fetchImpl } = await run([generated]);

  expect(result.incomplete).toBe(false);
  expect(result.value?.plan.questions).toEqual(generated.plan.questions);
  expect(result.questions.join('\n')).toContain('Q-VISIBILITY');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('does not weaken a manual expected result while repairing a source binding', async () => {
  const manualUrs = structuredClone(urs);
  const humanRequirement =
    'A human must inspect the physical workstation display for the Sample ID label and its field.';
  manualUrs.families[0].requirements[0].details.push(humanRequirement);
  const malformed = candidate();
  const manual = malformed.plan.cases[0];
  manual.manual = true;
  manual.manual_procedure = 'Open the form and inspect the Sample ID label.';
  manual.manual_expected =
    'The Sample ID label is visible and correctly associated with its field.';
  manual.manual_reason = {
    kind: 'explicit_manual_requirement',
    requirement_id: 'URS-001',
    source: 'URS-001/details/1',
    supporting_quote: humanRequirement,
    dependency: 'physical workstation display',
    explanation: 'The reviewed requirement explicitly requires physical human inspection.',
  };
  manual.steps = [];
  malformed.plan.obligations[0].assertion_ids = [];
  malformed.plan.obligations[0].manual_case_ids = [manual.id];
  malformed.plan.obligations[0].source = 'Unbound clause';
  const weakened = {
    edits: [
      { op: 'repair_obligation_source', obligation_id: 'OB-01', source: 'URS-001/statement' },
      {
        op: 'revise_manual_expected',
        case_id: manual.id,
        expected: 'A missing Sample ID label is also acceptable.',
      },
    ],
  };
  const { result } = await run([malformed, weakened, weakened], {
    urs: manualUrs,
  });

  expect(result.incomplete).toBe(true);
  expect(result.questions.join('\n')).toMatch(/manual|expected/i);
  expect(result.value?.plan.cases[0].manual_expected).toBe(manual.manual_expected);
  expect(result.value?.plan.obligations[0].source).toBe('Unbound clause');
});

it('repairs malformed CSV and text predicates while preserving valid expected results', async () => {
  const malformed = malformedPredicates();
  const corrected = correctedPredicates();
  const { result, fetchImpl } = await run([malformed, predicateEdits()]);

  expect(result.incomplete).toBe(false);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(result.value?.plan.cases[0].steps[0].assertions).toEqual(
    corrected.plan.cases[0].steps[0].assertions,
  );
  expect(result.value?.plan.cases[0].steps[0].assertions[0].expected).toBe(true);
  const correction = JSON.parse(requestBody(fetchImpl, 1).input[0].content[0].text);
  expect(
    correction.edit_catalog.repairable_assertions.map((item: { id: string }) => item.id),
  ).toEqual(['A-CSV', 'A-TEXT']);
  expect(correction.validation_errors.join('\n')).toContain('A-CSV: wildcard pattern');
  expect(correction.validation_errors.join('\n')).toContain('A-TEXT: matches supports literal');
  expect(result.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'document_structure' }),
      expect.objectContaining({
        kind: 'protocol_edits',
        candidate: expect.objectContaining({
          changes: expect.arrayContaining([
            expect.objectContaining({
              target: 'A-CSV',
              before: expect.objectContaining({ comparison: 'matches' }),
              after: expect.objectContaining({ comparison: 'csv_equals' }),
            }),
            expect.objectContaining({
              target: 'A-TEXT',
              after: expect.objectContaining({ comparison: 'contains_any' }),
            }),
          ]),
        }),
      }),
    ]),
  );
});

it('rejects an unrelated expected-result edit and uses the remaining correction on the original draft', async () => {
  const malformed = malformedPredicates();
  const weakened = {
    edits: [
      ...predicateEdits().edits,
      { op: 'repair_assertion', assertion_id: 'A-01', expected: false },
    ],
  };
  const { result, fetchImpl } = await run([malformed, weakened, predicateEdits()]);

  expect(result.incomplete).toBe(false);
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(result.value?.plan.cases[0].steps[0].assertions[0].expected).toBe(true);
  const rejection = result.diagnostics?.find(
    (diagnostic) => diagnostic.kind === 'protected_expectation',
  );
  expect(rejection).toMatchObject({
    candidate: { proposal: weakened },
    issues: expect.arrayContaining([
      expect.objectContaining({ message: expect.stringMatching(/A-01|expected|protect/i) }),
    ]),
  });
  const secondCorrection = JSON.parse(requestBody(fetchImpl, 2).input[0].content[0].text);
  expect(secondCorrection.candidate).toEqual(malformed);
  expect(secondCorrection.validation_errors.join('\n')).toContain('A-CSV: wildcard pattern');
  expect(secondCorrection.validation_errors.join('\n')).toMatch(/A-01|expected|protect/i);
});

it('retains the original draft after two rejected weakening edit proposals', async () => {
  const malformed = malformedPredicates();
  const weakened = {
    edits: [
      ...predicateEdits().edits,
      { op: 'repair_assertion', assertion_id: 'A-01', expected: false },
    ],
  };
  const { result, fetchImpl } = await run([malformed, weakened, weakened]);

  expect(result.incomplete).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(result.spend.calls).toBe(3);
  expect(result.value).toEqual(malformed);
  expect(
    result.diagnostics?.filter((diagnostic) => diagnostic.kind === 'protected_expectation'),
  ).toHaveLength(2);
  expect(result.diagnostics?.some((diagnostic) => diagnostic.kind === 'protocol_edits')).toBe(
    false,
  );
  expect(result.questions.join('\n')).toMatch(/A-01|expected|protect/i);
  expect(result.questions.join('\n')).not.toContain('Revise the requirement');
});

it('repairs a missing numeric tolerance without allowing its valid expected value to change', async () => {
  const malformed = candidate();
  malformed.plan.cases[0].steps[0].assertions.push(
    assertionSchema.parse({
      id: 'A-NUMERIC',
      locator: { by: 'label', value: 'Volume' },
      read: 'value',
      comparison: 'numeric',
      expected: 1.25,
    }),
  );
  malformed.plan.obligations[0].assertion_ids.push('A-NUMERIC');
  const weakened = {
    edits: [
      { op: 'repair_assertion', assertion_id: 'A-NUMERIC', tolerance: 0.001, expected: 9.99 },
    ],
  };
  const correction = {
    edits: [{ op: 'repair_assertion', assertion_id: 'A-NUMERIC', tolerance: 0.001 }],
  };
  const { result, fetchImpl } = await run([malformed, weakened, correction]);

  expect(result.incomplete).toBe(false);
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(result.value?.plan.cases[0].steps[0].assertions[1]).toMatchObject({
    comparison: 'numeric',
    expected: 1.25,
    tolerance: 0.001,
  });
  const rejected = result.diagnostics?.find(
    (diagnostic) => diagnostic.kind === 'protected_expectation',
  );
  expect(rejected?.candidate).toMatchObject({ proposal: weakened });
  const firstCorrection = JSON.parse(requestBody(fetchImpl, 1).input[0].content[0].text);
  expect(firstCorrection.edit_catalog.repairable_assertions).toEqual([
    expect.objectContaining({
      id: 'A-NUMERIC',
      fields: ['tolerance'],
    }),
  ]);
});
