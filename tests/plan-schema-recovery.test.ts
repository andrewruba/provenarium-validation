import { providerOutputText } from './provider-fixture.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generatePlan } from '../src/authoring/index.js';
import { planSchema, ursSchema } from '../src/schema.js';

const browser = vi.hoisted(() => ({ perform: vi.fn(), close: vi.fn() }));
vi.mock('../src/authoring/discovery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/authoring/discovery.js')>()),
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
    perform = browser.perform;
    close = browser.close;
  },
}));

const roots: string[] = [];
beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const urs = ursSchema.parse({
  schema_version: 1,
  document: {
    id: 'URS-SCHEMA',
    revision: '1',
    title: 'Synthetic register',
    intended_use: 'Record synthetic identifiers.',
  },
  families: [
    {
      id: 'entry',
      title: 'Entry',
      requirements: [
        { id: 'URS-001', title: 'Identifier', statement: 'Show a labeled Sample ID entry.' },
      ],
    },
  ],
});

function candidate() {
  return {
    plan: planSchema.parse({
      schema_version: 1,
      runtime_version: 1,
      id: 'PLAN-SCHEMA',
      title: 'Synthetic register protocol',
      urs_revision: '1',
      target: { url: 'https://example.test/', allowed_origins: ['https://example.test'] },
      environment: {},
      obligations: [
        {
          id: 'OB-01',
          requirement_id: 'URS-001',
          source: 'URS-001/statement',
          statement: 'Sample ID is visible.',
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
              instruction: 'Open the form and inspect the Sample ID entry.',
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

type Provider = 'openai' | 'anthropic';
const reviewed = { findings: [], summary: 'No further findings.' };
function transport(provider: Provider, values: unknown[], usage = true) {
  return vi.fn(async (_url: unknown, options?: RequestInit) => {
    const value = values.shift();
    if (value === undefined) throw new Error('Unexpected additional provider request.');
    if (value instanceof Error) throw value;
    if (value instanceof Response) return value;
    const text = providerOutputText(options, value);
    const tokenUsage = usage ? { usage: { input_tokens: 100, output_tokens: 50 } } : {};
    return new Response(
      JSON.stringify(
        provider === 'openai'
          ? {
              status: 'completed',
              ...tokenUsage,
              output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
            }
          : { stop_reason: 'end_turn', ...tokenUsage, content: [{ type: 'text', text }] },
      ),
    );
  });
}

async function run(
  values: unknown[],
  options: { provider?: Provider; usage?: boolean; maxSpend?: number } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'provenarium-schema-recovery-'));
  roots.push(root);
  const provider = options.provider ?? 'openai';
  const fetchImpl = transport(provider, values, options.usage);
  const result = await generatePlan({
    root,
    provider,
    key: 'synthetic-provider-key',
    urs,
    url: 'https://example.test/',
    thoroughness: 'quick',
    maxSpend: options.maxSpend,
    context: { passages: [], hashes: [], warnings: [] },
    fetchImpl,
  });
  return { result, fetchImpl, provider };
}

function inputAt(fetchImpl: ReturnType<typeof transport>, index: number, provider: Provider) {
  const request = JSON.parse(String(fetchImpl.mock.calls[index][1]?.body));
  return JSON.parse(
    provider === 'openai' ? request.input[0].content[0].text : request.messages[0].content,
  );
}

it.each(['openai', 'anthropic'] as const)(
  'repairs a schema-invalid %s plan using the rejected document and exact diagnostic paths',
  async (provider) => {
    const malformed = candidate();
    malformed.plan.cases[0].steps[0].assertions[0].comparison = 'approximately' as never;
    const { result, fetchImpl } = await run(
      [{ action: 'finish' }, malformed, candidate(), reviewed],
      { provider },
    );

    expect(result.incomplete).toBe(false);
    expect(result.value).toEqual(candidate());
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(browser.perform).not.toHaveBeenCalled();
    const retry = inputAt(fetchImpl, 2, provider);
    expect(retry.rejected_output.kind).toBe('document_schema');
    expect(retry.rejected_output.candidate.plan.cases[0].steps[0].assertions[0].comparison).toBe(
      'approximately',
    );
    expect(retry.validation_errors.join('\n')).toContain(
      '/plan/cases/0/steps/0/assertions/0/comparison',
    );
    expect(retry.obligation_sources).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'URS-001/statement' })]),
    );
    expect(result).toHaveProperty('diagnostics', [
      expect.objectContaining({ kind: 'document_schema', candidate: expect.any(Object) }),
    ]);
  },
);

it.each(['missing field', 'unknown field'] as const)(
  'recovers from a %s without accepting malformed data as a typed plan',
  async (kind) => {
    const malformed = JSON.parse(JSON.stringify(candidate()));
    if (kind === 'missing field') delete malformed.plan.cases[0].steps[0].instruction;
    if (kind === 'unknown field') malformed.plan.cases[0].steps[0].execute = 'not-executed';
    const { result, fetchImpl } = await run([
      { action: 'finish' },
      malformed,
      candidate(),
      reviewed,
    ]);

    expect(result.incomplete).toBe(false);
    expect(result.value).toEqual(candidate());
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(browser.perform).not.toHaveBeenCalled();
  },
);

it('repairs malformed discovery output before executing any browser action', async () => {
  const { result, fetchImpl } = await run([
    { action: 'unsupported-action', target: 'not-executed' },
    { action: 'finish' },
    candidate(),
    reviewed,
  ]);

  expect(result.incomplete).toBe(false);
  expect(fetchImpl).toHaveBeenCalledTimes(4);
  expect(browser.perform).not.toHaveBeenCalled();
  const retry = inputAt(fetchImpl, 1, 'openai');
  expect(retry.rejected_output.kind).toBe('document_schema');
  expect(retry.validation_errors.join('\n')).toContain('/action');
  expect(result).toHaveProperty('diagnostics', [
    expect.objectContaining({ operation: 'discovery' }),
  ]);
});

it('normalizes native nullable placeholders for omitted optional fields without a repair call', async () => {
  const nullable = JSON.parse(JSON.stringify(candidate()));
  nullable.plan.cases[0].actor = null;
  const { result, fetchImpl } = await run([{ action: 'finish' }, nullable, reviewed]);

  expect(result.incomplete).toBe(false);
  expect(result.value).toEqual(candidate());
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(result.diagnostics).toBeUndefined();
});

it('repairs malformed document JSON while retaining the rejected text as diagnostic data', async () => {
  const malformed = new Response(
    JSON.stringify({
      status: 'completed',
      usage: { input_tokens: 100, output_tokens: 50 },
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: '{"plan":' }],
        },
      ],
    }),
  );
  const { result, fetchImpl } = await run([{ action: 'finish' }, malformed, candidate(), reviewed]);

  expect(result.incomplete).toBe(false);
  expect(fetchImpl).toHaveBeenCalledTimes(4);
  expect(browser.perform).not.toHaveBeenCalled();
  const retry = inputAt(fetchImpl, 2, 'openai');
  expect(retry.rejected_output).toMatchObject({ kind: 'document_json', raw: '{"plan":' });
  expect(result).toHaveProperty('diagnostics', [
    expect.objectContaining({ operation: 'protocol draft', kind: 'document_json' }),
  ]);
});

it('retains schema diagnostics and stops after two unsuccessful corrections', async () => {
  const malformed = candidate();
  malformed.plan.cases[0].classification = 'PQ' as never;
  const { result, fetchImpl } = await run([{ action: 'finish' }, malformed, malformed, malformed]);

  expect(result.incomplete).toBe(true);
  expect(result.value).toBeUndefined();
  expect(result.reviewRounds).toBe(0);
  expect(fetchImpl).toHaveBeenCalledTimes(4);
  expect(result.spend.calls).toBe(4);
  expect(result).toHaveProperty(
    'diagnostics',
    expect.arrayContaining([
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ path: '/plan/cases/0/classification' }),
        ]),
      }),
    ]),
  );
  expect(browser.perform).not.toHaveBeenCalled();
});

it('shares the same two corrections between schema and structural failures', async () => {
  const schemaInvalid = candidate();
  schemaInvalid.plan.cases[0].classification = 'PQ' as never;
  const structuralInvalid = candidate();
  structuralInvalid.plan.obligations[0].source = 'An unbound prose label';
  const { result, fetchImpl } = await run([
    { action: 'finish' },
    schemaInvalid,
    structuralInvalid,
    schemaInvalid,
  ]);

  expect(result.incomplete).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(4);
  expect(result.reviewRounds).toBe(0);
  expect(inputAt(fetchImpl, 2, 'openai')).toHaveProperty('rejected_output');
  expect(inputAt(fetchImpl, 3, 'openai').validation_errors.join('\n')).toMatch(/source/i);
});

it('repairs a schema-invalid review response under the same command budget', async () => {
  const { result, fetchImpl } = await run([
    { action: 'finish' },
    candidate(),
    { findings: null, summary: 'Malformed review' },
    reviewed,
  ]);

  expect(result.incomplete).toBe(false);
  expect(result.reviewRounds).toBe(1);
  expect(fetchImpl).toHaveBeenCalledTimes(4);
  const retry = inputAt(fetchImpl, 3, 'openai');
  expect(retry.validation_errors.join('\n')).toContain('/findings');
  expect(retry.candidate.plan.id).toBe('PLAN-SCHEMA');
});

it('rejects a review edit that tries to change a protected expectation after schema recovery', async () => {
  const malformed = { edits: [{ op: 'update_instruction', case_id: 'IQ-01', step_id: 'S-01' }] };
  const forbidden = { edits: [{ op: 'repair_assertion', assertion_id: 'A-01', expected: false }] };
  const { result, fetchImpl } = await run([
    { action: 'finish' },
    candidate(),
    {
      findings: [
        { requirement: 'URS-001', severity: 'suggestion', message: 'Clarify instruction.' },
      ],
      summary: 'Clarify procedure.',
    },
    malformed,
    forbidden,
    forbidden,
  ]);

  expect(result.incomplete).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(6);
  expect(result.value?.plan.cases[0].steps[0].assertions[0].expected).toBe(true);
  expect(result.questions.join('\n')).toMatch(/review|protect|assertion/i);
  expect(result.diagnostics?.some((diagnostic) => diagnostic.kind === 'document_schema')).toBe(
    true,
  );
});

it.each(['delete_case', 'replace_case'] as const)(
  'rejects the unsupported %s operation instead of replacing existing checks',
  async (op) => {
    const forbidden = { edits: [{ op, case_id: 'IQ-01', manual: true }] };
    const { result, fetchImpl } = await run([
      { action: 'finish' },
      candidate(),
      {
        findings: [
          { requirement: 'URS-001', severity: 'suggestion', message: 'Clarify instruction.' },
        ],
        summary: 'Clarify procedure.',
      },
      forbidden,
      forbidden,
      forbidden,
    ]);

    expect(result.incomplete).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(result.value?.plan.cases).toEqual(candidate().plan.cases);
    expect(result.diagnostics?.every((diagnostic) => diagnostic.kind === 'document_schema')).toBe(
      true,
    );
  },
);

it('uses the remaining correction for a scoped instruction edit after a rejected expectation edit', async () => {
  const malformed = { edits: [{ op: 'update_instruction', case_id: 'IQ-01', step_id: 'S-01' }] };
  const forbidden = { edits: [{ op: 'repair_assertion', assertion_id: 'A-01', expected: false }] };
  const instruction = 'Open the form and inspect its labeled Sample ID entry.';
  const { result, fetchImpl } = await run([
    { action: 'finish' },
    candidate(),
    {
      findings: [
        { requirement: 'URS-001', severity: 'suggestion', message: 'Clarify instruction.' },
      ],
      summary: 'Clarify procedure.',
    },
    malformed,
    forbidden,
    { edits: [{ op: 'update_instruction', case_id: 'IQ-01', step_id: 'S-01', instruction }] },
  ]);

  expect(result.incomplete).toBe(false);
  expect(fetchImpl).toHaveBeenCalledTimes(6);
  expect(result.value?.plan.cases[0].steps[0].instruction).toBe(instruction);
  expect(result.value?.plan.cases[0].steps[0].assertions).toEqual(
    candidate().plan.cases[0].steps[0].assertions,
  );
  expect(result.questions).toEqual([]);
  const correction = inputAt(fetchImpl, 5, 'openai');
  expect(correction.validation_errors.join('\n')).toContain('/edits/0/op');
  expect(correction.rejected_output.candidate.edits[0].op).toBe('repair_assertion');
  expect(correction.findings).toHaveLength(1);
});

it('allows a scoped review edit to add automated cases while retaining existing checks', async () => {
  const initial = candidate();
  const additional = structuredClone(initial.plan.cases[0]);
  additional.id = 'IQ-02';
  additional.steps[0].id = 'S-02';
  additional.steps[0].assertions[0].id = 'A-02';
  additional.steps[0].evidence[0].id = 'E-02';
  const { result, fetchImpl } = await run([
    { action: 'finish' },
    initial,
    {
      findings: [
        { requirement: 'URS-001', severity: 'suggestion', message: 'Add another relevant check.' },
      ],
      summary: 'Expand coverage.',
    },
    { edits: [{ op: 'add_case', value: additional }] },
  ]);

  expect(result.incomplete).toBe(false);
  expect(fetchImpl).toHaveBeenCalledTimes(4);
  expect(result.value?.plan.cases[0]).toEqual(initial.plan.cases[0]);
  expect(result.value?.plan.cases[1]).toEqual(additional);
  expect(result.value?.plan.obligations).toEqual(initial.plan.obligations);
  const reviewRequest = JSON.parse(String(fetchImpl.mock.calls[3][1]?.body));
  expect(reviewRequest.text.format.schema.properties).toHaveProperty('edits');
  expect(reviewRequest.text.format.schema.properties).not.toHaveProperty('plan');
});

it('retains A16 and manual expected text verbatim while a review adds coverage', async () => {
  const initial = candidate();
  initial.plan.cases[0].steps[0].assertions[0].id = 'A16';
  initial.plan.obligations[0].assertion_ids = ['A16'];
  const manual = {
    id: 'OQ-04',
    title: 'Restart persistence',
    classification: 'OQ' as const,
    requirements: ['URS-001'],
    prerequisites: [],
    manual: true,
    manual_procedure: 'Restart the application and inspect the saved synthetic record.',
    manual_expected: 'The record remains SYNTHETIC-1 with value 1.250. Do not re-enter it.',
    steps: [],
    citations: [],
  };
  initial.plan.cases.push(manual);
  initial.plan.obligations[0].manual_case_ids.push(manual.id);
  const additional = structuredClone(initial.plan.cases[0]);
  additional.id = 'OQ-05';
  additional.steps[0].id = 'S-05';
  additional.steps[0].assertions[0].id = 'A-05';
  additional.steps[0].evidence[0].id = 'E-05';
  const { result, fetchImpl } = await run([
    { action: 'finish' },
    initial,
    {
      findings: [
        {
          requirement: 'URS-001',
          severity: 'suggestion',
          message: 'Add a boundary check without changing reviewed expectations.',
        },
      ],
      summary: 'Expand coverage.',
    },
    { edits: [{ op: 'add_case', value: additional }] },
  ]);

  expect(result.incomplete).toBe(false);
  expect(fetchImpl).toHaveBeenCalledTimes(4);
  expect(result.value?.plan.cases.slice(0, 2)).toEqual(initial.plan.cases);
  expect(result.value?.plan.cases[0].steps[0].assertions[0]).toMatchObject({
    id: 'A16',
    expected: true,
  });
  expect(
    result.value?.plan.cases.find((testCase) => testCase.id === 'OQ-04')?.manual_expected,
  ).toBe(manual.manual_expected);
  expect(result.value?.plan.obligations).toEqual(initial.plan.obligations);
});

it('retains the original structure errors while repairing a schema-invalid technical correction', async () => {
  const structuralInvalid = candidate();
  structuralInvalid.plan.obligations[0].source = 'An unbound prose label';
  const schemaInvalid = {
    edits: [{ op: 'repair_obligation_source', obligation_id: 'OB-01', source: null }],
  };
  const { result, fetchImpl } = await run([
    { action: 'finish' },
    structuralInvalid,
    schemaInvalid,
    {
      edits: [
        { op: 'repair_obligation_source', obligation_id: 'OB-01', source: 'URS-001/statement' },
      ],
    },
    reviewed,
  ]);

  expect(result.incomplete).toBe(false);
  expect(result.value).toEqual(candidate());
  expect(fetchImpl).toHaveBeenCalledTimes(5);
  const finalCorrection = inputAt(fetchImpl, 3, 'openai');
  expect(finalCorrection.validation_errors.join('\n')).toContain(
    'OB-01: source must point to existing text or a table in its requirement.',
  );
  expect(finalCorrection.validation_errors.join('\n')).toContain('/edits/0/source');
});

it.each(['network', 'refusal', 'incomplete'] as const)(
  'does not retry an ordinary %s failure as a schema correction',
  async (kind) => {
    const failed =
      kind === 'network'
        ? new Error('Synthetic network failure')
        : new Response(
            JSON.stringify({
              status: kind === 'incomplete' ? 'incomplete' : 'completed',
              usage: { input_tokens: 100, output_tokens: 50 },
              output: [
                { type: 'message', content: [{ type: 'refusal', refusal: 'Cannot complete.' }] },
              ],
            }),
          );
    const { result, fetchImpl } = await run([{ action: 'finish' }, failed]);

    expect(result.incomplete).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.value).toBeUndefined();
    expect(result).not.toHaveProperty('diagnostics');
  },
);

it('does not dispatch a correction when uncertain reservations consume the remaining cap', async () => {
  const probe = await run([{ action: 'finish' }, candidate(), reviewed]);
  const reservation = (index: number) => {
    const body = String(probe.fetchImpl.mock.calls[index][1]?.body);
    const request = JSON.parse(body);
    return ((Buffer.byteLength(body) + 32768) * 5 + request.max_output_tokens * 15) / 1e6;
  };
  const cap = reservation(0) + reservation(1) + 0.01;
  const malformed = candidate();
  malformed.plan.cases[0].steps[0].assertions[0].comparison = 'approximately' as never;
  const { result, fetchImpl } = await run([{ action: 'finish' }, malformed], {
    usage: false,
    maxSpend: cap,
  });

  expect(result.incomplete).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(result.spend.reserved).toBeGreaterThan(0);
  expect(result.questions.join('\n')).toMatch(/spending cap/i);
  expect(result).toHaveProperty('diagnostics', expect.any(Array));
});
