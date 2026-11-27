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
  options: {
    provider?: Provider;
    usage?: boolean;
    maxSpend?: number;
    urs?: typeof urs;
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'provenarium-schema-recovery-'));
  roots.push(root);
  const provider = options.provider ?? 'openai';
  const fetchImpl = transport(provider, values, options.usage);
  const result = await generatePlan({
    root,
    provider,
    key: 'synthetic-provider-key',
    urs: options.urs ?? urs,
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
  '%s automates manual work and its setup without reopening requirements',
  async (provider) => {
    const draft = candidate();
    draft.plan.cases.push({
      id: 'OQ-MANUAL',
      title: 'Persistent browser check',
      classification: 'OQ',
      requirements: ['URS-001'],
      prerequisites: ['Prepare a disposable persistent profile.'],
      manual: true,
      manual_procedure: 'Restart the browser and inspect the field.',
      manual_expected: 'The Sample ID field remains visible.',
      steps: [],
      citations: [],
    });
    draft.plan.questions = [
      {
        id: 'SETUP-PROFILE',
        question: 'Prepare the persistent profile before this check.',
        kind: 'execution_preparation',
        requirement: 'URS-001',
        case_ids: ['OQ-MANUAL'],
      },
    ];
    draft.plan.obligations.push({
      id: 'OB-02',
      requirement_id: 'URS-001',
      source: 'URS-001/statement',
      statement: 'Sample ID remains visible after restarting the browser.',
      assertion_ids: [],
      manual_case_ids: ['OQ-MANUAL'],
    });
    const automatedStep = structuredClone(draft.plan.cases[0].steps[0]);
    automatedStep.actions.push(
      { op: 'browser', command: 'open_profile', name: 'persistent', url: '/' },
      { op: 'browser', command: 'restart_profile', name: 'persistent' },
    );
    automatedStep.assertions[0].id = 'A-RESTART';
    automatedStep.evidence[0].id = 'E-RESTART';
    const edit = {
      edits: [
        {
          op: 'automate_case',
          case_id: 'OQ-MANUAL',
          preserved_manual_expected: 'The Sample ID field remains visible.',
          steps: [automatedStep],
          coverage: [{ obligation_id: 'OB-02', assertion_ids: ['A-RESTART'] }],
          preparation_resolutions: [
            {
              question_id: 'SETUP-PROFILE',
              explanation:
                'The runtime creates the named persistent profile and restarts it automatically.',
            },
          ],
          automated_prerequisites: [
            {
              prerequisite: 'Prepare a disposable persistent profile.',
              explanation:
                'open_profile creates the disposable persistent profile before restarting it.',
            },
          ],
        },
      ],
    };
    const { result, fetchImpl } = await run([draft, edit], {
      provider,
    });
    expect(result.incomplete).toBe(false);
    expect(result.value?.plan.cases.every((c) => !c.manual)).toBe(true);
    expect(result.value?.plan.cases[1].manual_expected).toBe(
      'The Sample ID field remains visible.',
    );
    expect(result.value?.plan.obligations[1]).toMatchObject({
      assertion_ids: ['A-RESTART'],
      manual_case_ids: [],
    });
    expect(result.value?.plan.questions).toEqual([]);
    expect(result.value?.plan.cases[1].prerequisites).toEqual([]);
    expect(result.questions).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const input = inputAt(fetchImpl, 0, provider);
    expect(input.runtime_contract.question_kinds).toContain('requirement_decision');
  },
);

it.each(['openai', 'anthropic'] as const)(
  'accepts repeated case-local step numbers from %s without paid repair requests',
  async (provider) => {
    const draft = candidate();
    draft.plan.cases = ['IQ-01', 'IQ-02', 'IQ-03'].map((caseId) => ({
      ...structuredClone(draft.plan.cases[0]),
      id: caseId,
      steps: ['01', '02'].map((stepId) => ({
        ...structuredClone(draft.plan.cases[0].steps[0]),
        id: stepId,
        assertions: [
          {
            ...draft.plan.cases[0].steps[0].assertions[0],
            id: `${caseId}-A-${stepId}`,
          },
        ],
        evidence: [{ id: `${caseId}-E-${stepId}`, kind: 'observation', required: true }],
      })),
    }));
    draft.plan.obligations[0].assertion_ids = draft.plan.cases.flatMap((testCase) =>
      testCase.steps.flatMap((step) => step.assertions.map((assertion) => assertion.id)),
    );
    const original = structuredClone(draft);
    const { result, fetchImpl } = await run([draft], { provider });

    expect(result.incomplete).toBe(false);
    expect(result.value).toEqual(original);
    expect(result.diagnostics ?? []).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(browser.perform).not.toHaveBeenCalled();
  },
);

it.each(['openai', 'anthropic'] as const)(
  'repairs a schema-invalid %s plan using the rejected document and exact diagnostic paths',
  async (provider) => {
    const malformed = candidate();
    malformed.plan.cases[0].steps[0].assertions[0].comparison = 'approximately' as never;
    const { result, fetchImpl } = await run([malformed, candidate()], {
      provider,
    });

    expect(result.incomplete).toBe(false);
    expect(result.value).toEqual(candidate());
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(browser.perform).not.toHaveBeenCalled();
    const retry = inputAt(fetchImpl, 1, provider);
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
    const { result, fetchImpl } = await run([malformed, candidate()]);

    expect(result.incomplete).toBe(false);
    expect(result.value).toEqual(candidate());
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(browser.perform).not.toHaveBeenCalled();
  },
);

it('normalizes native nullable placeholders for omitted optional fields without a repair call', async () => {
  const nullable = JSON.parse(JSON.stringify(candidate()));
  nullable.plan.cases[0].actor = null;
  const { result, fetchImpl } = await run([nullable]);

  expect(result.incomplete).toBe(false);
  expect(result.value).toEqual(candidate());
  expect(fetchImpl).toHaveBeenCalledTimes(1);
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
  const { result, fetchImpl } = await run([malformed, candidate()]);

  expect(result.incomplete).toBe(false);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(browser.perform).not.toHaveBeenCalled();
  const retry = inputAt(fetchImpl, 1, 'openai');
  expect(retry.rejected_output).toMatchObject({ kind: 'document_json', raw: '{"plan":' });
  expect(result).toHaveProperty('diagnostics', [
    expect.objectContaining({ operation: 'protocol draft', kind: 'document_json' }),
  ]);
});

it('retains schema diagnostics and stops after two unsuccessful corrections', async () => {
  const malformed = candidate();
  malformed.plan.cases[0].classification = 'PQ' as never;
  const { result, fetchImpl } = await run([malformed, malformed, malformed]);

  expect(result.incomplete).toBe(true);
  expect(result.value).toBeUndefined();
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(result.spend.calls).toBe(3);
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
  const { result, fetchImpl } = await run([schemaInvalid, structuralInvalid, schemaInvalid]);

  expect(result.incomplete).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(inputAt(fetchImpl, 1, 'openai')).toHaveProperty('rejected_output');
  expect(inputAt(fetchImpl, 2, 'openai').validation_errors.join('\n')).toMatch(/source/i);
});

it.each(['delete_case', 'replace_case'] as const)(
  'rejects the unsupported %s operation instead of replacing existing checks',
  async (op) => {
    const forbidden = { edits: [{ op, case_id: 'IQ-01', manual: true }] };
    const invalid = candidate();
    invalid.plan.obligations[0].source = 'An unbound prose label';
    const { result, fetchImpl } = await run([invalid, forbidden, forbidden]);

    expect(result.incomplete).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result.value?.plan).toEqual(invalid.plan);
    expect(result.diagnostics?.map(({ kind }) => kind)).toEqual([
      'document_structure',
      'document_schema',
      'document_schema',
    ]);
  },
);

it('retains the original structure errors while repairing a schema-invalid technical correction', async () => {
  const structuralInvalid = candidate();
  structuralInvalid.plan.obligations[0].source = 'An unbound prose label';
  const schemaInvalid = {
    edits: [{ op: 'repair_obligation_source', obligation_id: 'OB-01', source: null }],
  };
  const { result, fetchImpl } = await run([
    structuralInvalid,
    schemaInvalid,
    {
      edits: [
        { op: 'repair_obligation_source', obligation_id: 'OB-01', source: 'URS-001/statement' },
      ],
    },
  ]);

  expect(result.incomplete).toBe(false);
  expect(result.value).toEqual(candidate());
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  const finalCorrection = inputAt(fetchImpl, 2, 'openai');
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
    const { result, fetchImpl } = await run([failed]);

    expect(result.incomplete).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.value).toBeUndefined();
    expect(result).not.toHaveProperty('diagnostics');
  },
);

it('does not dispatch a correction when uncertain reservations consume the remaining cap', async () => {
  const probe = await run([candidate()]);
  const reservation = (index: number) => {
    const body = String(probe.fetchImpl.mock.calls[index][1]?.body);
    const request = JSON.parse(body);
    return ((Buffer.byteLength(body) + 32768) * 5 + request.max_output_tokens * 15) / 1e6;
  };
  const cap = reservation(0) + 0.01;
  const malformed = candidate();
  malformed.plan.cases[0].steps[0].assertions[0].comparison = 'approximately' as never;
  const { result, fetchImpl } = await run([malformed], {
    usage: false,
    maxSpend: cap,
  });

  expect(result.incomplete).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(result.spend.reserved).toBeGreaterThan(0);
  expect(result.questions.join('\n')).toMatch(/spending cap/i);
  expect(result).toHaveProperty('diagnostics', expect.any(Array));
});
