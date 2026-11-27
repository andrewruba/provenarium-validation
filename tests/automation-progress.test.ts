import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePlan } from '../src/authoring/index.js';
import { planSchema, ursSchema } from '../src/schema.js';
import { applyPlanEdits } from '../src/authoring/plan-edits.js';
import { providerOutputText } from './provider-fixture.js';

vi.mock('../src/authoring/discovery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/authoring/discovery.js')>()),
  Discovery: class {
    async open() {
      return {
        url: 'https://example.test/',
        title: 'Synthetic forms',
        text: 'Field 1 Field 2 Field 3 Field 4 Field 5',
        controls: [],
        links: [],
      };
    }
    async close() {}
  },
}));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const reviewed = { findings: [], summary: 'Every reviewed condition has executable coverage.' };
function example(count = 5) {
  const urs = ursSchema.parse({
    schema_version: 1,
    document: {
      id: 'URS',
      revision: '1',
      title: 'Synthetic forms',
      intended_use: 'Exercise visible synthetic fields.',
    },
    families: [
      {
        id: 'fields',
        title: 'Fields',
        requirements: Array.from({ length: count }, (_, i) => ({
          id: `R-${i + 1}`,
          title: `Field ${i + 1}`,
          statement: `Show the labeled Field ${i + 1} entry.`,
        })),
      },
    ],
  });
  const plan = planSchema.parse({
    schema_version: 1,
    runtime_version: 1,
    id: 'PLAN',
    title: 'Synthetic form protocol',
    urs_revision: '1',
    target: { url: 'https://example.test/', allowed_origins: ['https://example.test'] },
    environment: {},
    obligations: Array.from({ length: count }, (_, i) => ({
      id: `OB-${i + 1}`,
      requirement_id: `R-${i + 1}`,
      source: `R-${i + 1}/statement`,
      statement: `Field ${i + 1} is visible.`,
      manual_case_ids: [`OQ-${i + 1}`],
    })),
    cases: Array.from({ length: count }, (_, i) => ({
      id: `OQ-${i + 1}`,
      title: `Inspect field ${i + 1}`,
      classification: 'OQ',
      requirements: [`R-${i + 1}`],
      manual: true,
      manual_procedure: `Open the form and inspect Field ${i + 1}.`,
      manual_expected: `Field ${i + 1} is visible.`,
      steps: [],
    })),
  });
  return { urs, plan, fixtures: [] };
}
function conversion(i: number) {
  return {
    edits: [
      {
        op: 'automate_case',
        case_id: `OQ-${i}`,
        preserved_manual_expected: `Field ${i} is visible.`,
        coverage: [{ obligation_id: `OB-${i}`, assertion_ids: [`A-${i}`] }],
        steps: [
          {
            id: '01',
            instruction: `Open the form and inspect Field ${i}.`,
            actions: [{ op: 'navigate', url: '/' }],
            assertions: [
              {
                id: `A-${i}`,
                locator: { by: 'label', value: `Field ${i}` },
                read: 'visible',
                comparison: 'equals',
                expected: true,
              },
            ],
            evidence: [{ id: `E-${i}`, kind: 'observation' }],
          },
        ],
      },
    ],
  };
}
async function run(provider: 'openai' | 'anthropic', replies: unknown[], fixture = example()) {
  const root = await mkdtemp(join(tmpdir(), 'provenarium automation progress '));
  roots.push(root);
  const progress: string[] = [];
  const requests: Record<string, unknown>[] = [];
  const requestBytes: number[] = [];
  const transport = vi.fn(async (_url: unknown, options?: RequestInit) => {
    const body = JSON.parse(String(options?.body));
    requestBytes.push(Buffer.byteLength(String(options?.body)));
    requests.push(
      JSON.parse(provider === 'openai' ? body.input[0].content[0].text : body.messages[0].content),
    );
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    if (reply === undefined) throw new Error('Unexpected provider request.');
    const text = providerOutputText(options, reply);
    return new Response(
      JSON.stringify(
        provider === 'openai'
          ? {
              status: 'completed',
              usage: { input_tokens: 100, output_tokens: 50 },
              output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
            }
          : {
              stop_reason: 'end_turn',
              usage: { input_tokens: 100, output_tokens: 50 },
              content: [{ type: 'text', text }],
            },
      ),
    );
  });
  const result = await generatePlan({
    root,
    provider,
    key: 'synthetic-key',
    urs: fixture.urs,
    url: fixture.plan.target.url,
    maxSpend: 15,
    context: { passages: [], hashes: [], warnings: [] },
    fetchImpl: transport,
    onProgress: (message) => progress.push(message),
  });
  return { result, requests, requestBytes, progress, transport };
}

it.each(['openai', 'anthropic'] as const)(
  '%s completes five productive conversions without spending the structural correction allowance',
  async (provider) => {
    const fixture = example();
    const baseline = structuredClone(fixture);
    const { result, progress, transport } = await run(
      provider,
      [
        { plan: fixture.plan, fixtures: fixture.fixtures },
        ...Array.from({ length: 5 }, (_, i) => conversion(i + 1)),
      ],
      fixture,
    );
    expect(result.incomplete, result.questions.join('\n')).toBe(false);
    expect(result.value?.plan.cases.every((c) => !c.manual)).toBe(true);
    expect(
      result.value?.plan.obligations.every(
        (o) => o.manual_case_ids.length === 0 && o.assertion_ids.length === 1,
      ),
    ).toBe(true);
    expect(result.value?.plan.cases.map((c) => c.manual_expected)).toEqual(
      baseline.plan.cases.map((c) => c.manual_expected),
    );
    expect(
      progress.filter((message) => message.includes('Correcting generated protocol structure')),
    ).toEqual([]);
    expect(transport).toHaveBeenCalledTimes(6);
    expect(fixture).toEqual(baseline);
  },
);

it('stops a nonproductive conversion loop and retains the complete unmodified draft', async () => {
  const fixture = example(1);
  const { result, transport, requests } = await run(
    'openai',
    [{ plan: fixture.plan, fixtures: fixture.fixtures }, { edits: [] }, { edits: [] }],
    fixture,
  );
  expect(result.incomplete).toBe(true);
  expect(result.value?.plan.cases).toEqual(fixture.plan.cases);
  expect(result.questions.join('\n')).toMatch(/progress|automati/i);
  expect(requests[2].automation_task).toMatchObject({
    case_id: 'OQ-1',
    previous_attempt_did_not_convert_case: true,
  });
  expect(transport).toHaveBeenCalledTimes(3);
});

it('retains completed conversions if a later provider request fails', async () => {
  const fixture = example();
  const { result, transport } = await run(
    'openai',
    [
      { plan: fixture.plan, fixtures: fixture.fixtures },
      conversion(1),
      conversion(2),
      new Error('Synthetic provider failure'),
    ],
    fixture,
  );
  expect(result.incomplete).toBe(true);
  expect(result.value?.plan.cases.map((c) => c.manual)).toEqual([false, false, true, true, true]);
  expect(result.value?.plan.obligations[0]).toMatchObject({
    assertion_ids: ['A-1'],
    manual_case_ids: [],
  });
  expect(result.value?.plan.obligations[1]).toMatchObject({
    assertion_ids: ['A-2'],
    manual_case_ids: [],
  });
  expect(transport).toHaveBeenCalledTimes(4);
});

it('keeps the two schema corrections available after productive automation', async () => {
  const fixture = example(3);
  const invalid = { edits: [{ op: 'execute_shell', command: 'unsupported' }] };
  const { result, progress, transport } = await run(
    'openai',
    [
      { plan: fixture.plan, fixtures: fixture.fixtures },
      conversion(1),
      conversion(2),
      invalid,
      invalid,
      invalid,
    ],
    fixture,
  );
  expect(result.incomplete).toBe(true);
  expect(result.value?.plan.cases.map((c) => c.manual)).toEqual([false, false, true]);
  expect(
    progress.filter((message) => message.startsWith('Correcting provider output schema')),
  ).toHaveLength(2);
  expect(result.questions.join('\n')).toContain('schema correction limit');
  expect(transport).toHaveBeenCalledTimes(6);
});

it('keeps the full draft while fitting large technical corrections into case requests', async () => {
  const fixture = example(4);
  const conversions = fixture.plan.cases.map((_item, index) => conversion(index + 1).edits[0]);
  fixture.plan = planSchema.parse({
    ...fixture.plan,
    cases: fixture.plan.cases.map((item, index) => ({
      ...item,
      manual: false,
      steps: [
        {
          ...conversions[index].steps[0],
          instruction: `Case ${index + 1} procedure. `.repeat(3000),
        },
      ],
    })),
    obligations: fixture.plan.obligations.map((item, index) => ({
      ...item,
      source: index === 0 ? 'Unbound source' : item.source,
      manual_case_ids: [],
      assertion_ids: [`A-${index + 1}`],
    })),
  });
  const before = structuredClone(fixture.plan);
  const { result, requests, requestBytes, transport } = await run(
    'openai',
    [
      { plan: fixture.plan, fixtures: [] },
      {
        edits: [{ op: 'repair_obligation_source', obligation_id: 'OB-1', source: 'R-1/statement' }],
      },
      { edits: [] },
      { edits: [] },
      { edits: [] },
    ],
    fixture,
  );
  expect(result.incomplete, result.questions.join('\n')).toBe(false);
  expect(result.value?.plan.cases).toEqual(before.cases);
  expect(result.value?.plan.obligations[0].source).toBe('R-1/statement');
  expect(requestBytes.every((bytes) => bytes <= 200000)).toBe(true);
  expect(transport).toHaveBeenCalledTimes(5);
  for (const request of requests.slice(1)) {
    expect(request.urs).toEqual(fixture.urs);
    expect(request.case_inventory).toHaveLength(4);
  }
});
