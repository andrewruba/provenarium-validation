import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generatePlan } from '../src/authoring/index.js';
import { planSchema, ursSchema } from '../src/schema.js';

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

const reviewed = { findings: [], summary: 'No further findings.' };
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
            content: [
              { type: 'output_text', text: JSON.stringify({ payload: JSON.stringify(next) }) },
            ],
          },
        ],
      }),
    );
  });
}

async function run(values: unknown[]) {
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
    fetchImpl,
  });
  return { result, fetchImpl };
}

function requestBody(fetchImpl: ReturnType<typeof transport>, index: number) {
  return JSON.parse(String(fetchImpl.mock.calls[index][1]?.body));
}

it('supplies exact source bindings and runtime rules and normalizes an unambiguous local source', async () => {
  const generated = candidate();
  generated.plan.obligations[0].source = 'statement';
  const { result, fetchImpl } = await run([{ action: 'finish' }, generated, reviewed]);

  expect(result.incomplete).toBe(false);
  expect(result.value?.plan.obligations[0].source).toBe('URS-001/statement');
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  const input = JSON.parse(requestBody(fetchImpl, 1).input[0].content[0].text);
  expect(JSON.stringify(input.obligation_sources)).toContain('URS-001/statement');
  expect(JSON.stringify(input.obligation_sources)).toContain('URS-001/details/0');
  expect(input.available_reference_files).toEqual([]);
  expect(input.runtime_contract).toHaveProperty('source_syntax');
  expect(input.runtime_contract).toHaveProperty('anonymous_access');
  expect(input.runtime_contract).toHaveProperty('artifact_rules');
});

it('repairs invalid source bindings and prose references using validator feedback before review', async () => {
  const malformed = candidate();
  malformed.plan.obligations[0].source = 'The form requirement above';
  malformed.plan.references = ['URS-SYNTHETIC, Draft 1, including accepted human resolutions.'];
  const corrected = candidate();
  const { result, fetchImpl } = await run([{ action: 'finish' }, malformed, corrected, reviewed]);

  expect(result.incomplete).toBe(false);
  expect(result.value?.plan.references).toEqual([]);
  expect(result.value?.plan.obligations[0].source).toBe('URS-001/statement');
  expect(result.value?.plan.cases[0].steps[0].assertions).toEqual(
    corrected.plan.cases[0].steps[0].assertions,
  );
  const repair = JSON.parse(requestBody(fetchImpl, 2).input[0].content[0].text);
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
  const { result, fetchImpl } = await run([{ action: 'finish' }, malformed, malformed, malformed]);

  expect(result.incomplete).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(4);
  expect(result.questions.join('\n')).toMatch(/source|reference/i);
  expect(result.reviewRounds).toBe(0);
  expect(result.spend.calls).toBe(4);
});

it('validates and repairs a semantic revision before returning it as complete', async () => {
  const initial = candidate();
  const malformedRevision = candidate();
  malformedRevision.plan.obligations[0].source = 'revised statement clause';
  malformedRevision.plan.references = ['This is a plan execution note, not a filename.'];
  const { result, fetchImpl } = await run([
    { action: 'finish' },
    initial,
    {
      findings: [
        {
          requirement: 'URS-001',
          severity: 'suggestion',
          message: 'Clarify the test instruction.',
        },
      ],
      summary: 'Improve readability.',
    },
    malformedRevision,
    candidate(),
  ]);

  expect(result.incomplete).toBe(false);
  expect(result.reviewRounds).toBe(1);
  expect(result.value?.plan.references).toEqual([]);
  const correction = JSON.parse(requestBody(fetchImpl, 4).input[0].content[0].text);
  expect(correction.validation_errors.join('\n')).toContain(malformedRevision.plan.references[0]);
  expect(result.value?.plan.cases[0].manual).toBe(false);
});

it('does not weaken an expected outcome to get a technical correction through validation', async () => {
  const malformed = candidate();
  malformed.plan.obligations[0].source = 'Unbound clause';
  const weakened = candidate();
  weakened.plan.cases[0].steps[0].assertions[0].expected = false;
  const { result } = await run([{ action: 'finish' }, malformed, weakened, weakened]);

  expect(result.incomplete).toBe(true);
  expect(result.questions.join('\n')).toMatch(/expected result|expected outcome|expectation/i);
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
  const { result, fetchImpl } = await run([{ action: 'finish' }, malformed, candidate(), reviewed]);

  expect(result.incomplete).toBe(false);
  expect(result.value?.plan.questions).toEqual([]);
  const correction = JSON.parse(requestBody(fetchImpl, 2).input[0].content[0].text);
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
  const { result, fetchImpl } = await run([{ action: 'finish' }, generated, reviewed]);

  expect(result.incomplete).toBe(false);
  expect(result.value?.plan.questions).toEqual(generated.plan.questions);
  expect(result.questions.join('\n')).toContain('Q-VISIBILITY');
  expect(fetchImpl).toHaveBeenCalledTimes(3);
});

it('does not weaken a manual expected result while repairing a source binding', async () => {
  const malformed = candidate();
  const manual = malformed.plan.cases[0];
  manual.manual = true;
  manual.manual_procedure = 'Open the form and inspect the Sample ID label.';
  manual.manual_expected =
    'The Sample ID label is visible and correctly associated with its field.';
  manual.steps = [];
  malformed.plan.obligations[0].assertion_ids = [];
  malformed.plan.obligations[0].manual_case_ids = [manual.id];
  malformed.plan.obligations[0].source = 'Unbound clause';
  const weakened = structuredClone(malformed);
  weakened.plan.obligations[0].source = 'URS-001/statement';
  weakened.plan.cases[0].manual_expected = 'A missing Sample ID label is also acceptable.';
  const { result } = await run([{ action: 'finish' }, malformed, weakened, weakened]);

  expect(result.incomplete).toBe(true);
  expect(result.questions.join('\n')).toMatch(/manual|expected/i);
});
