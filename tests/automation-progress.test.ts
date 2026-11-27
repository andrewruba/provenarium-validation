import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePlan } from '../src/authoring/index.js';
import { planSchema, ursSchema } from '../src/schema.js';
import { applyPlanEdits } from '../src/authoring/plan-edits.js';
import { providerOutputText } from './provider-fixture.js';

const rehearsalMock = vi.hoisted(() => vi.fn());
vi.mock('../src/authoring/rehearsal.js', () => ({ rehearsePlan: rehearsalMock }));

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
  rehearsalMock.mockReset();
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
async function run(
  provider: 'openai' | 'anthropic',
  replies: unknown[],
  fixture = example(),
  options: {
    existing?: boolean;
    automationOnly?: boolean;
    rehearse?: boolean;
    thoroughness?: 'quick' | 'standard' | 'thorough';
    reviewCoverage?: boolean;
  } = {},
) {
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
    ...(options.existing
      ? { existing: fixture.plan, existingUrs: fixture.urs, existingFixtures: fixture.fixtures }
      : {}),
    automationOnly: options.automationOnly,
    rehearse: options.rehearse,
    reviewCoverage: options.reviewCoverage,
    allowInteractions: options.rehearse,
    url: fixture.plan.target.url,
    thoroughness: options.thoroughness ?? 'quick',
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
        { action: 'finish' },
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
    expect(transport).toHaveBeenCalledTimes(7);
    expect(fixture).toEqual(baseline);
  },
);

it('stops a nonproductive conversion loop and retains the complete unmodified draft', async () => {
  const fixture = example(1);
  const { result, transport, requests } = await run(
    'openai',
    [
      { action: 'finish' },
      { plan: fixture.plan, fixtures: fixture.fixtures },
      { edits: [] },
      { edits: [] },
    ],
    fixture,
  );
  expect(result.incomplete).toBe(true);
  expect(result.value?.plan.cases).toEqual(fixture.plan.cases);
  expect(result.questions.join('\n')).toMatch(/progress|automati/i);
  expect(requests[3].automation_task).toMatchObject({
    case_id: 'OQ-1',
    previous_attempt_did_not_convert_case: true,
  });
  expect(transport).toHaveBeenCalledTimes(4);
});

it('retains completed conversions if a later provider request fails', async () => {
  const fixture = example();
  const { result, transport } = await run(
    'openai',
    [
      { action: 'finish' },
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
  expect(transport).toHaveBeenCalledTimes(5);
});

it('keeps the two schema corrections available after productive automation', async () => {
  const fixture = example(3);
  const invalid = { edits: [{ op: 'execute_shell', command: 'unsupported' }] };
  const { result, progress, transport } = await run(
    'openai',
    [
      { action: 'finish' },
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
  expect(transport).toHaveBeenCalledTimes(7);
});

it('continues an existing partial automation plan without a broad revision request', async () => {
  const fixture = example(3);
  fixture.plan = planSchema.parse({
    ...fixture.plan,
    cases: fixture.plan.cases.map((c, index) =>
      index === 0 ? { ...c, manual: false, steps: conversion(1).edits[0].steps } : c,
    ),
    obligations: fixture.plan.obligations.map((o, index) =>
      index === 0 ? { ...o, manual_case_ids: [], assertion_ids: ['A-1'] } : o,
    ),
  });
  const first = structuredClone(fixture.plan.cases[0]);
  const { result, transport, requests } = await run(
    'openai',
    [{ action: 'finish' }, conversion(2), conversion(3)],
    fixture,
    { existing: true, automationOnly: true },
  );
  expect(result.incomplete, result.questions.join('\n')).toBe(false);
  expect(result.value?.plan.cases[0]).toEqual(first);
  expect(result.value?.plan.cases.every((c) => !c.manual)).toBe(true);
  expect((requests[1].automation_task as { case_id: string }).case_id).toBe('OQ-2');
  expect(transport).toHaveBeenCalledTimes(3);
});

it('uses one limited advisory request after automation grows the full candidate beyond the request limit', async () => {
  const fixture = example();
  const conversions = Array.from({ length: 5 }, (_, i) => {
    const edit = conversion(i + 1);
    edit.edits[0].steps[0].instruction = `Reviewed procedure ${i + 1}. `.repeat(3000);
    return edit;
  });
  const { result, requests, requestBytes, transport } = await run(
    'openai',
    [{ action: 'finish' }, { plan: fixture.plan, fixtures: [] }, ...conversions, reviewed],
    fixture,
    { reviewCoverage: true },
  );
  expect(result.incomplete, result.questions.join('\n')).toBe(false);
  expect(Buffer.byteLength(JSON.stringify(result.value))).toBeGreaterThan(200000);
  expect(requestBytes.every((bytes) => bytes <= 200000)).toBe(true);
  expect(requests.slice(7)).toHaveLength(1);
  expect(requests[7].cases as unknown[]).toHaveLength(5);
  expect(result.coverageReview).toEqual(reviewed);
  expect(result.coverageReviewWarning).toContain('Detailed procedures and fixtures were omitted');
  expect(
    result.value?.plan.cases.every(
      (c, index) =>
        c.steps[0].instruction === conversions[index].edits[0].steps[0].instruction.trim(),
    ),
  ).toBe(true);
  expect(transport).toHaveBeenCalledTimes(8);
  expect(
    result.diagnostics?.some(
      (diagnostic) => diagnostic.kind === 'protocol_edits' && diagnostic.truncated,
    ),
  ).toBe(true);
  expect(result.automationProposals).toHaveLength(5);
  let replay = { plan: fixture.plan, fixtures: fixture.fixtures };
  for (const proposal of result.automationProposals!)
    replay = applyPlanEdits(replay, proposal, {
      urs: fixture.urs,
      mode: 'review',
      allowManualConversion: true,
    }).value;
  expect(JSON.stringify(replay) === JSON.stringify(result.value)).toBe(true);
});

it('splits a large existing-plan revision into scoped edits and keeps the complete baseline', async () => {
  const fixture = example();
  fixture.plan = planSchema.parse({
    ...fixture.plan,
    cases: fixture.plan.cases.map((c, index) => ({
      ...c,
      manual: false,
      steps: [
        {
          ...conversion(index + 1).edits[0].steps[0],
          instruction: `Reviewed procedure ${index + 1}. `.repeat(3000),
        },
      ],
    })),
    obligations: fixture.plan.obligations.map((o, index) => ({
      ...o,
      manual_case_ids: [],
      assertion_ids: [`A-${index + 1}`],
    })),
  });
  const before = structuredClone(fixture.plan);
  const { result, requests, requestBytes, transport } = await run(
    'anthropic',
    [{ action: 'finish' }, ...Array.from({ length: 5 }, () => ({ edits: [] }))],
    fixture,
    { existing: true },
  );
  expect(result.incomplete, result.questions.join('\n')).toBe(false);
  expect(result.value?.plan).toEqual(before);
  expect(requestBytes.every((bytes) => bytes <= 200000)).toBe(true);
  const edits = requests.slice(1, 6);
  expect(
    edits.map((request) => (request.request_scope as { case_ids: string[] }).case_ids),
  ).toEqual([['OQ-1'], ['OQ-2'], ['OQ-3'], ['OQ-4'], ['OQ-5']]);
  for (const request of edits) expect((request.case_inventory as unknown[]).length).toBe(5);
  expect(transport).toHaveBeenCalledTimes(6);
});

it.each(['schema', 'scoped-edit'] as const)(
  'keeps the complete candidate while omitting oversized untrusted %s correction output',
  async (failure) => {
    const fixture = example(1);
    fixture.plan = planSchema.parse({
      ...fixture.plan,
      cases: [
        {
          ...fixture.plan.cases[0],
          manual: false,
          steps: [
            {
              ...conversion(1).edits[0].steps[0],
              instruction: 'Retain the reviewed procedure. '.repeat(4000),
            },
          ],
        },
      ],
      obligations: [
        { ...fixture.plan.obligations[0], manual_case_ids: [], assertion_ids: ['A-1'] },
      ],
    });
    const before = structuredClone(fixture.plan);
    const rejected =
      failure === 'schema'
        ? { edits: [{ op: 'execute_shell', command: 'Untrusted rejected text. '.repeat(2400) }] }
        : {
            edits: [
              {
                op: 'update_instruction',
                case_id: 'OQ-1',
                step_id: 'UNKNOWN',
                instruction: 'Untrusted rejected text. '.repeat(2400),
              },
            ],
          };
    const { result, requests, requestBytes, transport } = await run(
      'openai',
      [{ action: 'finish' }, rejected, { edits: [] }],
      fixture,
      { existing: true },
    );
    expect(result.incomplete, result.questions.join('\n')).toBe(false);
    expect(result.value?.plan).toEqual(before);
    expect(requestBytes.every((bytes) => bytes <= 200000)).toBe(true);
    const corrected = requests[2];
    expect(corrected.candidate).toEqual({ plan: before, fixtures: [] });
    expect((corrected.validation_errors as string[]).length).toBeGreaterThan(0);
    if (failure === 'schema')
      expect(corrected.rejected_output).toMatchObject({
        output_omitted: { bytes: expect.any(Number) },
        issues: expect.any(Array),
      });
    else
      expect(corrected.rejected_proposal).toMatchObject({
        omitted: true,
        bytes: expect.any(Number),
      });
    expect(result.diagnostics?.length).toBeGreaterThan(0);
    expect(transport).toHaveBeenCalledTimes(3);
  },
);

it('retains failed rehearsal assertions without another provider call', async () => {
  const fixture = example(2);
  fixture.plan = planSchema.parse({
    ...fixture.plan,
    cases: fixture.plan.cases.map((c, index) => ({
      ...c,
      manual: false,
      steps: conversion(index + 1).edits[0].steps,
    })),
    obligations: fixture.plan.obligations.map((o, index) => ({
      ...o,
      manual_case_ids: [],
      assertion_ids: [`A-${index + 1}`],
    })),
  });
  const observations = [
    { case_id: 'OQ-1', assertion_id: 'A-1', status: 'failed', expected: true, actual: false },
    { case_id: 'OQ-2', assertion_id: 'A-2', status: 'failed', expected: true, actual: false },
    {
      case_id: 'OQ-1',
      assertion_id: 'A-OTHER',
      status: 'passed',
      expected: 'confirmed',
      actual: 'Successful evidence '.repeat(15000),
    },
  ];
  const rehearsal = {
    kind: 'authoring_diagnostics',
    plan_sha256: 'synthetic-plan-hash',
    cases: [
      { id: 'OQ-1', status: 'failed' },
      { id: 'OQ-2', status: 'failed' },
    ],
    observations,
  };
  rehearsalMock.mockResolvedValueOnce(rehearsal);
  const { result, transport } = await run(
    'openai',
    [{ action: 'finish' }, { edits: [] }],
    fixture,
    { existing: true, rehearse: true },
  );
  expect(result.incomplete, result.questions.join('\n')).toBe(false);
  expect(result.rehearsal).toEqual(rehearsal);
  expect(result.value?.plan.cases.map((c) => c.steps[0].assertions[0].expected)).toEqual([
    true,
    true,
  ]);
  expect(transport).toHaveBeenCalledTimes(2);
  expect(rehearsalMock).toHaveBeenCalledTimes(1);
});

it('keeps the automation checkpoint intact when advisory review proposes changes', async () => {
  const fixture = example(1);
  const finding = {
    findings: [
      {
        requirement: 'R-1',
        severity: 'suggestion',
        message: 'Clarify the executable procedure while retaining the expected result.',
      },
    ],
    summary: 'Clarify procedure.',
  };
  const { result, transport } = await run(
    'openai',
    [{ action: 'finish' }, { plan: fixture.plan, fixtures: [] }, conversion(1), finding],
    fixture,
    { thoroughness: 'standard', reviewCoverage: true },
  );
  expect(result.incomplete, result.questions.join('\n')).toBe(false);
  expect(result.coverageReview).toEqual(finding);
  expect(result.automationProposals).toHaveLength(1);
  const replay = applyPlanEdits(
    { plan: fixture.plan, fixtures: [] },
    result.automationProposals![0],
    { urs: fixture.urs, mode: 'review', allowManualConversion: true },
  ).value;
  expect(result.value).toEqual(replay);
  expect(transport).toHaveBeenCalledTimes(4);
});

it.each(['quick', 'standard', 'thorough'] as const)(
  'makes advisory review optional on the %s preset',
  async (thoroughness) => {
    const fixture = example(1);
    const { result, transport } = await run(
      'openai',
      [{ action: 'finish' }, { plan: fixture.plan, fixtures: [] }, conversion(1)],
      fixture,
      { thoroughness },
    );
    expect(result.incomplete).toBe(false);
    expect(result.reviewRounds).toBe(0);
    expect(transport).toHaveBeenCalledTimes(3);
  },
);

it('retains a validated plan when Chromium cannot start or the optional provider call fails', async () => {
  const fixture = example(1);
  rehearsalMock.mockRejectedValueOnce(new Error('Chromium unavailable.'));
  const { result, transport } = await run(
    'openai',
    [
      { action: 'finish' },
      { plan: fixture.plan, fixtures: [] },
      conversion(1),
      new Error('Synthetic provider failure.'),
    ],
    fixture,
    { rehearse: true, reviewCoverage: true },
  );
  expect(result.incomplete).toBe(false);
  expect(result.value?.plan.cases[0].manual).toBe(false);
  expect(result.rehearsalWarning).toContain('Chromium unavailable.');
  expect(result.coverageReviewWarning).toBeDefined();
  expect(result.rehearsal).toBeUndefined();
  expect(result.coverageReview).toBeUndefined();
  expect(result.questions).toEqual([]);
  expect(transport).toHaveBeenCalledTimes(4);
});
