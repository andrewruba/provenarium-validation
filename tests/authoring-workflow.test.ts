import { describe, expect, it, vi } from 'vitest';
import { planSchema, ursSchema } from '../src/schema.js';
import { draftUrs, generatePlan, reviewUrs } from '../src/authoring/index.js';

vi.mock('../src/authoring/discovery.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/authoring/discovery.js')>();
  return {
    ...original,
    Discovery: class {
      async open() {
        return {
          url: 'http://localhost:3210/',
          title: 'Samples',
          text: 'Sample ID',
          controls: [{ label: 'Sample ID', type: 'text' }],
          links: [],
        };
      }
      async perform() {
        return this.open();
      }
      async close() {}
    },
  };
});
const urs = ursSchema.parse({
  schema_version: 1,
  document: { id: 'URS', revision: '1', title: 'Register', intended_use: 'Receive samples' },
  families: [
    {
      id: 'receipt',
      title: 'Receipt',
      requirements: [
        {
          id: 'URS-001',
          title: 'Form',
          statement: 'The sample receipt form shall show Sample ID.',
        },
      ],
    },
  ],
  open_questions: [],
});
const plan = planSchema.parse({
  schema_version: 1,
  runtime_version: 1,
  id: 'PLAN-1',
  title: 'Register IOQ',
  urs_revision: '1',
  target: { url: 'http://localhost:3210', allowed_origins: ['http://localhost:3210'] },
  environment: {},
  access: [],
  obligations: [
    {
      id: 'OB-1',
      requirement_id: 'URS-001',
      source: '/families/0/requirements/0/statement',
      statement: 'Sample ID is displayed',
      assertion_ids: ['A-1'],
    },
  ],
  cases: [
    {
      id: 'OQ-1',
      title: 'Form',
      classification: 'OQ',
      requirements: ['URS-001'],
      steps: [
        {
          id: 'S-1',
          instruction: 'Open sample form',
          actions: [{ op: 'navigate', url: '/' }],
          assertions: [
            {
              id: 'A-1',
              locator: { by: 'label', value: 'Sample ID' },
              read: 'visible',
              comparison: 'equals',
              expected: true,
            },
          ],
          evidence: [{ id: 'E-1', kind: 'observation' }],
        },
      ],
    },
  ],
});
function transport(provider: 'openai' | 'anthropic', values: unknown[]) {
  return vi.fn(async () => {
    const value = values.shift();
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error('Unexpected provider call');
    const text = JSON.stringify({ payload: JSON.stringify(value) });
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
}
describe('authoring workflows', () => {
  it.each(['openai', 'anthropic'] as const)(
    'drafts and reviews with %s while preserving human edits',
    async (provider) => {
      const changed = structuredClone(urs);
      changed.families[0].requirements[0].statement = 'Model changed a human requirement';
      const result = await draftUrs({
        root: '/tmp',
        provider,
        key: 'test-key',
        brief: 'Receipt register',
        existing: urs,
        thoroughness: 'quick',
        fetchImpl: transport(provider, [changed, { findings: [], summary: 'Reviewed' }]),
      });
      expect(result.incomplete).toBe(false);
      expect(result.reviewRounds).toBe(1);
      expect(result.value?.families[0].requirements[0].statement).toBe(
        urs.families[0].requirements[0].statement,
      );
    },
  );
  it('retains the completed draft after a later request fails', async () => {
    const result = await draftUrs({
      root: '/tmp',
      provider: 'openai',
      key: 'test-key',
      brief: 'Receipt register',
      fetchImpl: transport('openai', [urs, new Error('Transport failure')]),
    });
    expect(result.incomplete).toBe(true);
    expect(result.value).toEqual(urs);
    expect(result.spend.reserved).toBeGreaterThan(0);
    expect(result.questions.join()).toContain('reservation');
  });
  it.each([
    ['quick', 1],
    ['standard', 2],
    ['thorough', 3],
  ] as const)('%s performs at most %i relevant review passes', async (thoroughness, count) => {
    const values = [];
    for (let i = 0; i < count; i++)
      values.push({
        findings: [
          { requirement: 'URS-001', severity: 'suggestion', message: `Review point ${i}` },
        ],
        summary: 'Review',
      });
    const result = await reviewUrs({
      root: '/tmp',
      provider: 'anthropic',
      key: 'test-key',
      urs,
      thoroughness,
      fetchImpl: transport('anthropic', values),
    });
    expect(result.reviewRounds).toBe(count);
    expect(result.value?.findings).toHaveLength(count);
    expect(result.incomplete).toBe(false);
  });
  it('stops deeper review early when no actionable findings remain', async () => {
    const requests = transport('openai', [{ findings: [], summary: 'No additional findings' }]);
    const result = await reviewUrs({
      root: '/tmp',
      provider: 'openai',
      key: 'test-key',
      urs,
      thoroughness: 'thorough',
      fetchImpl: requests,
    });
    expect(result.reviewRounds).toBe(1);
    expect(requests).toHaveBeenCalledTimes(1);
    expect(result.spend.actual).toBeLessThan(40);
  });
  it.each(['openai', 'anthropic'] as const)(
    'authors typed %s tests from bounded discovery',
    async (provider) => {
      const result = await generatePlan({
        root: '/tmp',
        provider,
        key: 'test-key',
        urs,
        url: 'http://localhost:3210',
        thoroughness: 'quick',
        fetchImpl: transport(provider, [
          { action: 'finish' },
          { plan, fixtures: [] },
          { findings: [], summary: 'Reviewed' },
        ]),
      });
      expect(result.incomplete).toBe(false);
      expect(result.value?.plan.target.url).toBe('http://localhost:3210/');
      expect(result.value?.plan.obligations[0].assertion_ids).toEqual(['A-1']);
    },
  );
  it('does not permit a generated test to expand network scope', async () => {
    const changed = structuredClone(plan);
    changed.cases[0].steps[0].actions = [{ op: 'navigate', url: 'https://attacker.example/' }];
    const result = await generatePlan({
      root: '/tmp',
      provider: 'openai',
      key: 'test-key',
      urs,
      url: 'http://localhost:3210',
      fetchImpl: transport('openai', [{ action: 'finish' }, { plan: changed, fixtures: [] }]),
    });
    expect(result.incomplete).toBe(true);
    expect(result.questions.join()).toContain('expand allowed origins');
    expect(result.value).toBeUndefined();
  });
  it('refuses fixture path traversal and executable fixture content types', async () => {
    for (const filename of ['fixtures/../../outside.txt', 'fixtures/attack.js']) {
      const changed = structuredClone(plan);
      changed.fixtures = [filename];
      const result = await generatePlan({
        root: '/tmp',
        provider: 'openai',
        key: 'test-key',
        urs,
        url: 'http://localhost:3210',
        fetchImpl: transport('openai', [
          { action: 'finish' },
          { plan: changed, fixtures: [{ path: filename, content: 'malicious' }] },
        ]),
      });
      expect(result.incomplete).toBe(true);
      expect(result.questions.join()).toContain('fixture path');
    }
  });
  it('does not change expected outcomes to make rehearsal or feedback pass', async () => {
    const changed = structuredClone(plan);
    changed.cases[0].steps[0].assertions[0].expected = false;
    const result = await generatePlan({
      root: '/tmp',
      provider: 'openai',
      key: 'test-key',
      urs,
      url: 'http://localhost:3210',
      existing: plan,
      feedback: 'Make it pass',
      fetchImpl: transport('openai', [{ action: 'finish' }, { plan: changed, fixtures: [] }]),
    });
    expect(result.incomplete).toBe(true);
    expect(result.questions.join()).toContain('expected result');
  });
  it('keeps unknown requirements explicit in generated candidates', async () => {
    const unresolved = structuredClone(urs);
    unresolved.open_questions = [
      { id: 'Q-1', requirement: 'URS-001', question: 'Which account may see this field?' },
    ];
    const result = await generatePlan({
      root: '/tmp',
      provider: 'openai',
      key: 'test-key',
      urs: unresolved,
      url: 'http://localhost:3210',
      fetchImpl: transport('openai', [
        { action: 'finish' },
        { plan, fixtures: [] },
        { findings: [], summary: 'Review' },
      ]),
    });
    expect(result.value?.plan.questions).toContainEqual(unresolved.open_questions[0]);
    expect(result.questions.join()).toContain('Resolve URS questions');
  });
  it('allows reviewed expectation changes only for requirements changed in a new URS revision', async () => {
    const revisedUrs = structuredClone(urs);
    revisedUrs.document.revision = '2';
    revisedUrs.families[0].requirements[0].statement =
      'The sample receipt form shall hide Sample ID.';
    const revisedPlan = structuredClone(plan);
    revisedPlan.urs_revision = '2';
    revisedPlan.cases[0].steps[0].assertions[0].expected = false;
    const result = await generatePlan({
      root: '/tmp',
      provider: 'openai',
      key: 'test-key',
      urs: revisedUrs,
      existingUrs: urs,
      existing: plan,
      url: 'http://localhost:3210',
      fetchImpl: transport('openai', [
        { action: 'finish' },
        { plan: revisedPlan, fixtures: [] },
        { findings: [], summary: 'Reviewed requirement change' },
      ]),
    });
    expect(result.incomplete).toBe(false);
    expect(result.value?.plan.cases[0].steps[0].assertions[0].expected).toBe(false);
    revisedUrs.families[0].requirements[0].statement = urs.families[0].requirements[0].statement;
    revisedUrs.families[0].requirements[0].title = 'Cosmetic title revision';
    const unchanged = await generatePlan({
      root: '/tmp',
      provider: 'openai',
      key: 'test-key',
      urs: revisedUrs,
      existingUrs: urs,
      existing: plan,
      url: 'http://localhost:3210',
      fetchImpl: transport('openai', [{ action: 'finish' }, { plan: revisedPlan, fixtures: [] }]),
    });
    expect(unchanged.incomplete).toBe(true);
    expect(unchanged.questions.join()).toContain('expected result');
  });
  it('rejects unsupported executable provider actions before executing anything', async () => {
    const result = await generatePlan({
      root: '/tmp',
      provider: 'anthropic',
      key: 'test-key',
      urs,
      url: 'http://localhost:3210',
      fetchImpl: transport('anthropic', [
        { action: 'evaluate', code: 'fetch("https://attacker.example")' },
      ]),
    });
    expect(result.incomplete).toBe(true);
    expect(result.value).toBeUndefined();
    expect(result.questions.join()).toContain('schema validation');
  });
  it('retains an explicit approval blocker when bounded discovery never finishes', async () => {
    const result = await generatePlan({
      root: '/tmp',
      provider: 'openai',
      key: 'test-key',
      urs,
      url: 'http://localhost:3210',
      thoroughness: 'quick',
      fetchImpl: transport('openai', [
        ...Array.from({ length: 4 }, () => ({ action: 'inspect' })),
        { plan, fixtures: [] },
        { findings: [], summary: 'Reviewed' },
      ]),
    });
    expect(result.incomplete).toBe(true);
    expect(result.value?.plan.questions.some((q) => q.id === 'Q-DISCOVERY-LIMIT')).toBe(true);
    expect(result.questions.join()).toContain('action limit');
  });
});
