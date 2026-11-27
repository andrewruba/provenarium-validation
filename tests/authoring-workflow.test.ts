import { providerOutputText } from './provider-fixture.js';
import { resolutionProviderValue } from './resolution-fixture.js';
import { describe, expect, it, vi } from 'vitest';
import { planSchema, ursSchema } from '../src/schema.js';
import { draftUrs, generatePlan, proposeUrsResolution } from '../src/authoring/index.js';
import { applyResolutionProposal } from '../src/urs-resolution.js';

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
  return vi.fn(async (_url: unknown, _options?: RequestInit) => {
    const value = values.shift();
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error('Unexpected provider call');
    const text = providerOutputText(_options, value);
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

it('drafts requirements in one request before human review', async () => {
  const fetchImpl = transport('openai', [urs]);
  const result = await draftUrs({
    root: process.cwd(),
    provider: 'openai',
    key: 'synthetic-key',
    url: plan.target.url,
    fetchImpl,
  });
  expect(result.incomplete).toBe(false);
  expect(result.value).toEqual(urs);
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it('authors the protocol directly from browser observations and approved requirements', async () => {
  const fetchImpl = transport('openai', [{ plan, fixtures: [] }]);
  const result = await generatePlan({
    root: process.cwd(),
    provider: 'openai',
    key: 'synthetic-key',
    urs,
    url: plan.target.url,
    fetchImpl,
  });
  expect(result.incomplete).toBe(false);
  expect(result.value?.plan.cases).toEqual(plan.cases);
  expect(fetchImpl).toHaveBeenCalledOnce();
  const request = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
  const input = JSON.parse(request.input[0].content[0].text);
  expect(input.urs).toEqual(urs);
  expect(input.observations).toMatchObject([{ controls: [{ label: 'Sample ID' }] }]);
});

function answeredUrs() {
  const document = structuredClone(urs);
  document.open_questions = [
    {
      id: 'Q-ACCESS',
      requirement: 'URS-001',
      question: 'Should Sample ID be visible on the receipt form?',
      answer: 'Yes, show Sample ID to the operator.',
    },
  ];
  return document;
}
function answerProposal(document = answeredUrs()) {
  return {
    requirements: [
      {
        question_ids: ['Q-ACCESS'],
        value: structuredClone(document.families[0].requirements[0]),
        reason: 'The existing visibility requirement already expresses the recorded answer.',
      },
    ],
    unresolved: [],
  };
}

describe('answer-based requirements authoring', () => {
  it.each(['openai', 'anthropic'] as const)(
    'proposes one scoped requirement update using recorded answers with %s',
    async (provider) => {
      const document = answeredUrs();
      const proposal = answerProposal(document);
      proposal.requirements[0].value.details = ['The operator shall see Sample ID on receipt.'];
      const requests = transport(provider, [resolutionProviderValue(proposal)]);
      const context = { passages: [], hashes: [], warnings: [] };
      const result = await proposeUrsResolution({
        root: '/tmp',
        provider,
        key: 'test-key',
        urs: document,
        context,
        thoroughness: 'thorough',
        fetchImpl: requests,
      });

      expect(result.incomplete).toBe(false);
      expect(result.value).toEqual(proposal);
      expect(result.spend.calls).toBe(1);
      expect(requests).toHaveBeenCalledOnce();
      const request = JSON.parse(String(requests.mock.calls[0][1]?.body));
      const payload = JSON.parse(
        provider === 'openai' ? request.input[0].content[0].text : request.messages[0].content,
      );
      expect(payload).toEqual({ urs: document, answers: document.open_questions, context });
      expect(document.open_questions[0]).not.toHaveProperty('resolution');
      expect(document.families[0].requirements[0]).not.toHaveProperty('details');
    },
  );

  it('makes no provider request when there are no unapplied answers', async () => {
    const answered = answeredUrs();
    const resolved = applyResolutionProposal(answered, answerProposal(answered));
    const requests = transport('openai', []);
    const result = await proposeUrsResolution({
      root: '/tmp',
      provider: 'openai',
      key: '',
      urs: resolved,
      fetchImpl: requests,
    });
    expect(requests).not.toHaveBeenCalled();
    expect(result.value).toEqual({ requirements: [], unresolved: [] });
    expect(result.spend.calls).toBe(0);
  });

  it('retains a specific ambiguity without applying or inventing an answer', async () => {
    const document = answeredUrs();
    document.open_questions[0].answer = 'It depends on the operator.';
    const proposal = {
      requirements: [],
      unresolved: [{ question_id: 'Q-ACCESS', reason: 'Which operator roles may see Sample ID?' }],
    };
    const result = await proposeUrsResolution({
      root: '/tmp',
      provider: 'openai',
      key: 'test-key',
      urs: document,
      fetchImpl: transport('openai', [resolutionProviderValue(proposal)]),
    });
    expect(result.incomplete).toBe(false);
    expect(result.value).toEqual(proposal);
    expect(result.questions).toContain('Q-ACCESS: Which operator roles may see Sample ID?');
    expect(document.open_questions[0]).not.toHaveProperty('resolution');
  });

  it('rejects a proposal that introduces a requirement outside the existing document', async () => {
    const proposal = answerProposal();
    proposal.requirements[0].value.id = 'INVENTED';
    const result = await proposeUrsResolution({
      root: '/tmp',
      provider: 'openai',
      key: 'test-key',
      urs: answeredUrs(),
      fetchImpl: transport(
        'openai',
        Array.from({ length: 3 }, () => resolutionProviderValue(proposal)),
      ),
    });
    expect(result.incomplete).toBe(true);
    expect(result.value).toBeUndefined();
    expect(JSON.stringify(result.diagnostics)).toContain('INVENTED');
  });

  it('stops before dispatch when the budget cannot cover resolution authoring', async () => {
    const requests = transport('openai', [resolutionProviderValue(answerProposal())]);
    const result = await proposeUrsResolution({
      root: '/tmp',
      provider: 'openai',
      key: 'test-key',
      urs: answeredUrs(),
      maxSpend: 0.000001,
      fetchImpl: requests,
    });
    expect(result.incomplete).toBe(true);
    expect(result.value).toBeUndefined();
    expect(requests).not.toHaveBeenCalled();
    expect(result.questions.join()).toContain('spending cap');
  });

  it('removes invented answers and resolution claims from the draft', async () => {
    const proposed = answeredUrs();
    proposed.open_questions[0].resolution = {
      answer_hash: 'a'.repeat(64),
      applied_at: '2026-11-25T00:00:00.000Z',
      targets: ['requirement:URS-001'],
      decision: {
        authority: 'delegated',
        basis: 'decision',
        rationale: 'Invented authority',
        citations: [],
      },
    };
    const requests = transport('openai', [proposed]);
    const result = await draftUrs({
      root: '/tmp',
      provider: 'openai',
      key: 'test-key',
      thoroughness: 'quick',
      fetchImpl: requests,
    });
    expect(result.value?.open_questions[0]).toEqual({
      id: 'Q-ACCESS',
      requirement: 'URS-001',
      question: proposed.open_questions[0].question,
      answer: null,
    });
  });

  it('keeps resolved URS history out of unresolved plan questions while retaining new conflicts', async () => {
    const answered = answeredUrs();
    const resolved = applyResolutionProposal(answered, answerProposal(answered));
    for (const newConflict of [false, true]) {
      const proposedPlan = structuredClone(plan);
      proposedPlan.urs_revision = resolved.document.revision;
      proposedPlan.questions = [
        {
          id: 'Q-ACCESS',
          requirement: 'URS-001',
          question: newConflict
            ? 'A new conflict with visibility needs review.'
            : answered.open_questions[0].question,
        },
      ];
      const result = await generatePlan({
        root: '/tmp',
        provider: 'openai',
        key: 'test-key',
        urs: resolved,
        url: 'http://localhost:3210',
        fetchImpl: transport('openai', [{ plan: proposedPlan, fixtures: [] }]),
      });
      expect(result.incomplete).toBe(false);
      expect(result.value?.plan.questions).toEqual(newConflict ? proposedPlan.questions : []);
      expect(result.questions.join()).not.toContain('Resolve URS questions');
      if (newConflict) expect(result.questions.join()).toContain('new conflict');
    }
  });

  it('keeps an answer awaiting requirement review as a plain plan approval blocker', async () => {
    const result = await generatePlan({
      root: '/tmp',
      provider: 'openai',
      key: 'test-key',
      urs: answeredUrs(),
      url: 'http://localhost:3210',
      fetchImpl: transport('openai', [{ plan, fixtures: [] }]),
    });
    expect(result.value?.plan.questions[0]).toEqual({
      id: 'Q-ACCESS',
      requirement: 'URS-001',
      question: 'Answer recorded; continue validation to review its requirement changes.',
    });
    expect(result.questions.join()).toContain('Resolve URS questions');
  });
});

describe('authoring workflows', () => {
  it.each(['openai', 'anthropic'] as const)(
    'drafts with %s from context and the app without requiring an interview brief',
    async (provider) => {
      const context = {
        passages: [
          {
            source: 'design',
            location: 'design.md',
            text: 'Scientists receive samples in a register. The form must show Sample ID.',
          },
        ],
        hashes: [],
        warnings: [],
      };
      const revised = structuredClone(urs);
      revised.families[0].requirements[0].citations = [{ source: 'design', location: 'design.md' }];
      revised.open_questions = [
        {
          id: 'Q-DUPLICATE',
          requirement: 'URS-001',
          question: 'Should a duplicate Sample ID be rejected or update the existing sample?',
          answer: null,
        },
      ];
      const requests = transport(provider, [revised]);
      const result = await draftUrs({
        root: '/tmp',
        provider,
        key: 'test-key',
        context,
        url: 'http://localhost:3210',
        thoroughness: 'quick',
        fetchImpl: requests,
      });

      expect(result.incomplete).toBe(false);
      expect(result.value).toEqual(revised);
      expect(result.questions).toEqual([
        'Q-DUPLICATE: Should a duplicate Sample ID be rejected or update the existing sample?',
      ]);
      expect(requests).toHaveBeenCalledTimes(1);
      for (const [, options] of requests.mock.calls) {
        const request = JSON.parse(String(options?.body));
        const payload = JSON.parse(
          provider === 'openai' ? request.input[0].content[0].text : request.messages[0].content,
        );
        expect(payload).not.toHaveProperty('brief');
        expect(payload.context).toEqual(context);
        expect(payload.observation).toMatchObject({
          url: 'http://localhost:3210/',
          title: 'Samples',
          text: 'Sample ID',
        });
      }
    },
  );
  it.each(['openai', 'anthropic'] as const)(
    'authors typed %s tests from a read-only browser snapshot',
    async (provider) => {
      const result = await generatePlan({
        root: '/tmp',
        provider,
        key: 'test-key',
        urs,
        url: 'http://localhost:3210',
        thoroughness: 'quick',
        fetchImpl: transport(provider, [{ plan, fixtures: [] }]),
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
      fetchImpl: transport('openai', [{ plan: changed, fixtures: [] }]),
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
          { plan: changed, fixtures: [{ path: filename, content: 'malicious' }] },
        ]),
      });
      expect(result.incomplete).toBe(true);
      expect(result.questions.join()).toContain('fixture path');
    }
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
      fetchImpl: transport('openai', [{ plan, fixtures: [] }]),
    });
    expect(result.value?.plan.questions).toContainEqual(unresolved.open_questions[0]);
    expect(result.questions.join()).toContain('Resolve URS questions');
  });
  it('rejects unsupported executable provider actions before executing anything', async () => {
    const requests = transport(
      'anthropic',
      Array.from({ length: 3 }, () => ({
        action: 'evaluate',
        code: 'fetch("https://attacker.example")',
      })),
    );
    const result = await generatePlan({
      root: '/tmp',
      provider: 'anthropic',
      key: 'test-key',
      urs,
      url: 'http://localhost:3210',
      fetchImpl: requests,
    });
    expect(result.incomplete).toBe(true);
    expect(result.value).toBeUndefined();
    expect(result.questions.join()).toContain('schema validation');
    expect(result.questions.join()).toContain('correction limit');
    expect(result.diagnostics).toHaveLength(3);
    expect(requests).toHaveBeenCalledTimes(3);
  });
});
