import { providerOutputText } from './provider-fixture.js';
import { resolutionProviderValue } from './resolution-fixture.js';
import { describe, expect, it, vi } from 'vitest';
import { planSchema, ursSchema } from '../src/schema.js';
import { draftUrs, generatePlan, proposeUrsResolution, reviewUrs } from '../src/authoring/index.js';
import { blankUrs } from '../src/urs.js';
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

  it('removes invented answers and resolution claims from both drafts and revisions', async () => {
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
    const requests = transport('openai', [
      proposed,
      {
        findings: [
          { requirement: 'URS-001', severity: 'suggestion', message: 'Keep the question.' },
        ],
        summary: 'Review',
      },
      proposed,
    ]);
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
    const reviewRequest = JSON.parse(String(requests.mock.calls[1][1]?.body));
    const reviewedQuestion = JSON.parse(reviewRequest.input[0].content[0].text).urs
      .open_questions[0];
    expect(reviewedQuestion.answer).toBeNull();
    expect(reviewedQuestion).not.toHaveProperty('resolution');
  });

  it('preserves the original answered question and its accepted resolution during redrafting', async () => {
    const answered = answeredUrs();
    const existing = applyResolutionProposal(answered, answerProposal(answered));
    const proposed = structuredClone(existing);
    proposed.open_questions[0].question = 'May the model replace the decision?';
    proposed.open_questions[0].answer = 'Model replacement';
    delete proposed.open_questions[0].resolution;
    const result = await draftUrs({
      root: '/tmp',
      provider: 'openai',
      key: 'test-key',
      existing,
      fetchImpl: transport('openai', [proposed, { findings: [], summary: 'Reviewed' }]),
    });
    expect(result.value?.open_questions).toEqual(existing.open_questions);
    expect(result.questions).toEqual([]);
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
        fetchImpl: transport('openai', [
          { action: 'finish' },
          { plan: proposedPlan, fixtures: [] },
          { findings: [], summary: 'Reviewed' },
        ]),
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
      fetchImpl: transport('openai', [{ action: 'finish' }, { plan, fixtures: [] }]),
    });
    expect(result.value?.plan.questions[0]).toEqual({
      id: 'Q-ACCESS',
      requirement: 'URS-001',
      question: 'Answer recorded; run provenarium urs resolve to review its requirement changes.',
    });
    expect(result.questions.join()).toContain('Resolve URS questions');
  });
});

describe('authoring workflows', () => {
  it.each(['openai', 'anthropic'] as const)(
    'drafts and reviews with %s while preserving human edits',
    async (provider) => {
      const changed = structuredClone(urs);
      changed.families[0].requirements[0].statement = 'Model changed a human requirement';
      changed.document.title = 'Model changed a human title';
      changed.document.intended_use = 'Model changed intended use';
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
      expect(result.value?.document).toEqual(urs.document);
    },
  );
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
      const requests = transport(provider, [
        urs,
        {
          findings: [
            { requirement: 'URS-001', severity: 'suggestion', message: 'Cite the design source.' },
          ],
          summary: 'Clarify duplicate handling without guessing.',
        },
        revised,
      ]);
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
      expect(requests).toHaveBeenCalledTimes(3);
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
  it('fills an untouched blank template without freezing its empty document fields', async () => {
    const existing = structuredClone(blankUrs);
    const requests = transport('openai', [urs, { findings: [], summary: 'Reviewed' }]);
    const result = await draftUrs({
      root: '/tmp',
      provider: 'openai',
      key: 'test-key',
      existing,
      url: 'http://localhost:3210',
      thoroughness: 'quick',
      fetchImpl: requests,
    });

    expect(result.incomplete).toBe(false);
    expect(result.value).toEqual(urs);
    expect(existing).toEqual(blankUrs);
    const request = JSON.parse(String(requests.mock.calls[0][1]?.body));
    expect(JSON.parse(request.input[0].content[0].text)).not.toHaveProperty('existing');
  });
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
        fetchImpl: transport(provider, [{ action: 'finish' }, { plan, fixtures: [] }]),
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
    const forbidden = { edits: [{ op: 'revise_assertion', assertion_id: 'A-1', expected: false }] };
    const result = await generatePlan({
      root: '/tmp',
      provider: 'openai',
      key: 'test-key',
      urs,
      url: 'http://localhost:3210',
      existing: plan,
      feedback: 'Make it pass',
      fetchImpl: transport('openai', [
        { action: 'finish' },
        ...Array.from({ length: 3 }, () => forbidden),
      ]),
    });
    expect(result.incomplete).toBe(true);
    expect(result.questions.join()).toMatch(/expected|reviewed|requirement|protect/i);
    expect(result.value?.plan.cases[0].steps[0].assertions[0].expected).toBe(true);
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
      fetchImpl: transport('openai', [{ action: 'finish' }, { plan, fixtures: [] }]),
    });
    expect(result.value?.plan.questions).toContainEqual(unresolved.open_questions[0]);
    expect(result.questions.join()).toContain('Resolve URS questions');
  });
  it('allows reviewed expectation changes only for requirements changed in a new URS revision', async () => {
    const revisedUrs = structuredClone(urs);
    revisedUrs.document.revision = '2';
    revisedUrs.families[0].requirements[0].statement =
      'The sample receipt form shall hide Sample ID.';
    const revision = { edits: [{ op: 'revise_assertion', assertion_id: 'A-1', expected: false }] };
    const result = await generatePlan({
      root: '/tmp',
      provider: 'openai',
      key: 'test-key',
      urs: revisedUrs,
      existingUrs: urs,
      existing: plan,
      url: 'http://localhost:3210',
      fetchImpl: transport('openai', [{ action: 'finish' }, revision]),
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
      fetchImpl: transport('openai', [
        { action: 'finish' },
        ...Array.from({ length: 3 }, () => revision),
      ]),
    });
    expect(unchanged.incomplete).toBe(true);
    expect(unchanged.questions.join()).toMatch(/expected|reviewed|requirement|protect/i);
    expect(unchanged.value?.plan.cases[0].steps[0].assertions[0].expected).toBe(true);
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
