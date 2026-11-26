import { providerOutputText } from './provider-fixture.js';
import { resolutionProviderValue } from './resolution-fixture.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Budget, proposeUrsResolution, suggestUrsAnswers } from '../src/authoring/index.js';
import { ursSchema, type Urs } from '../src/schema.js';
import { applyResolutionProposal, type UrsResolutionProposal } from '../src/urs-resolution.js';
import { pendingAnsweredQuestions, questionStatus } from '../src/urs.js';
import {
  answerSuggestionQuestions,
  validateUrsAnswerSuggestions,
  type UrsAnswerSuggestions,
} from '../src/urs-answers.js';

const browser = vi.hoisted(() => ({
  options: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
}));
vi.mock('../src/authoring/discovery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/authoring/discovery.js')>()),
  Discovery: class {
    constructor(options: unknown) {
      browser.options(options);
    }
    open = browser.open;
    close = browser.close;
  },
}));
const context = {
  passages: [
    {
      source: 'design',
      location: 'design.md',
      text: 'Empty exports contain column headings only.',
    },
  ],
  hashes: [],
  warnings: [],
};
function document() {
  return ursSchema.parse({
    schema_version: 1,
    document: { id: 'URS', revision: '1', title: 'Register', intended_use: 'Record samples.' },
    families: [
      {
        id: 'records',
        title: 'Records',
        requirements: [{ id: 'URS-CSV', title: 'CSV', statement: 'Provide a CSV export.' }],
      },
    ],
    open_questions: [
      {
        id: 'Q-CSV',
        requirement: 'URS-CSV',
        question: 'What should an empty export contain?',
        answer: null,
      },
    ],
  });
}
function suggestions(): UrsAnswerSuggestions {
  return {
    suggestions: [
      {
        question_id: 'Q-CSV',
        answer: 'Download a header-only CSV with no data rows.',
        basis: 'documented',
        explanation: 'The supplied design specifies headings for an empty export.',
        citations: [{ source: 'design', location: 'design.md' }],
        choices: [],
      },
    ],
  };
}
function transport(provider: 'openai' | 'anthropic', values: unknown[]) {
  return vi.fn(async (_url: unknown, _options?: RequestInit) => {
    const value = values.shift();
    if (value === undefined) throw new Error('Unexpected provider request');
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
beforeEach(() => {
  vi.clearAllMocks();
  browser.open.mockResolvedValue({
    url: 'https://example.test/',
    title: 'Register',
    text: 'Download CSV',
    controls: [],
    links: [],
  });
});

describe('context-based answer suggestions', () => {
  it.each(['openai', 'anthropic'] as const)(
    'offers a sourced answer for confirmation without accepting it using %s',
    async (provider) => {
      const urs = document();
      const original = structuredClone(urs);
      const requests = transport(provider, [suggestions()]);
      const result = await suggestUrsAnswers({
        root: '/tmp',
        provider,
        key: 'test-key',
        urs,
        context,
        fetchImpl: requests,
      });

      expect(result.value).toEqual(suggestions());
      expect(result.incomplete).toBe(false);
      expect(result.spend.calls).toBe(1);
      expect(urs).toEqual(original);
      const request = JSON.parse(String(requests.mock.calls[0][1]?.body));
      const input = JSON.parse(
        provider === 'openai' ? request.input[0].content[0].text : request.messages[0].content,
      );
      expect(input).toEqual({ urs, selected_questions: urs.open_questions, context });
      expect(provider === 'openai' ? request.instructions : request.system).toContain(
        'A suggestion is not an accepted answer',
      );
    },
  );

  it('offers explicit alternatives when the context cannot decide the policy', async () => {
    const value = suggestions();
    value.suggestions[0] = {
      question_id: 'Q-CSV',
      answer: null,
      basis: 'decision',
      explanation: 'The supplied material does not specify empty exports.',
      citations: [],
      choices: [
        'Download a header-only CSV.',
        'Block the download and show an empty-register message.',
      ],
    };
    const result = await suggestUrsAnswers({
      root: '/tmp',
      provider: 'openai',
      key: 'test-key',
      urs: document(),
      context: { passages: [], hashes: [], warnings: [] },
      fetchImpl: transport('openai', [value]),
    });
    expect(result.incomplete).toBe(false);
    expect(result.value).toEqual(value);
  });

  it('defaults to unanswered questions and permits explicit revisiting without changing recorded answers', async () => {
    const urs = document();
    urs.open_questions[0].answer = 'Show a no-records message.';
    const requests = transport('openai', [suggestions()]);
    const empty = await suggestUrsAnswers({
      root: '/tmp',
      provider: 'openai',
      key: '',
      urs,
      fetchImpl: requests,
    });
    expect(empty.value).toEqual({ suggestions: [] });
    expect(requests).not.toHaveBeenCalled();
    const revisited = await suggestUrsAnswers({
      root: '/tmp',
      provider: 'openai',
      key: 'test-key',
      urs,
      questionIds: ['Q-CSV'],
      context,
      fetchImpl: requests,
    });
    expect(revisited.value).toEqual(suggestions());
    expect(urs.open_questions[0].answer).toBe('Show a no-records message.');
  });

  it('includes a read-only application observation and validates its citation', async () => {
    const value = suggestions();
    value.suggestions[0].basis = 'implementation';
    value.suggestions[0].citations = [
      { source: '@application', location: 'https://example.test/' },
    ];
    const requests = transport('openai', [value]);
    const result = await suggestUrsAnswers({
      root: '/tmp',
      provider: 'openai',
      key: 'test-key',
      urs: document(),
      context,
      url: 'https://example.test/',
      fetchImpl: requests,
    });
    expect(result.incomplete).toBe(false);
    expect(browser.options).toHaveBeenCalledWith(
      expect.objectContaining({ allowInteractions: false }),
    );
    expect(browser.open).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
    const request = JSON.parse(String(requests.mock.calls[0][1]?.body));
    expect(JSON.parse(request.input[0].content[0].text).observation.text).toBe('Download CSV');
  });

  it('continues from supplied context when optional application inspection fails', async () => {
    browser.open.mockRejectedValueOnce(new Error('Browser unavailable'));
    const result = await suggestUrsAnswers({
      root: '/tmp',
      provider: 'openai',
      key: 'test-key',
      urs: document(),
      context,
      url: 'https://example.test/',
      fetchImpl: transport('openai', [suggestions()]),
    });
    expect(result.value).toEqual(suggestions());
    expect(result.questions.join()).toContain('Optional application inspection unavailable');
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it('shares one command budget with the subsequent requirement proposal', async () => {
    const urs = document();
    const budget = new Budget(1);
    const proposal = {
      requirements: [
        {
          question_ids: ['Q-CSV'],
          value: urs.families[0].requirements[0],
          reason: 'Apply the accepted answer.',
        },
      ],
      unresolved: [],
    };
    const requests = transport('openai', [suggestions(), resolutionProviderValue(proposal)]);
    const options = {
      root: '/tmp',
      provider: 'openai' as const,
      key: 'test-key',
      urs,
      context,
      budget,
      fetchImpl: requests,
    };
    const first = await suggestUrsAnswers(options);
    expect(first.spend.calls).toBe(1);
    urs.open_questions[0].answer = suggestions().suggestions[0].answer;
    const second = await proposeUrsResolution(options);
    expect(second.incomplete).toBe(false);
    expect(second.spend.calls).toBe(2);
    expect(second.spend.actual).toBeCloseTo(first.spend.actual * 2);
    expect(second.spend.cap).toBe(1);
  });

  it('does not reset the remaining command ceiling between suggestions and proposals', async () => {
    const urs = document();
    const budget = new Budget(1);
    const requests = transport('openai', [suggestions()]);
    const options = {
      root: '/tmp',
      provider: 'openai' as const,
      key: 'test-key',
      urs,
      context,
      budget,
      fetchImpl: requests,
    };
    const first = await suggestUrsAnswers(options);
    expect(first.incomplete).toBe(false);
    budget.reserve(budget.cap - budget.snapshot().actual - 0.000001);
    urs.open_questions[0].answer = 'Download a header-only CSV.';
    const second = await proposeUrsResolution(options);
    expect(second.incomplete).toBe(true);
    expect(second.questions.join()).toContain('remaining spending cap');
    expect(requests).toHaveBeenCalledOnce();
  });
});

describe('suggestion scope and evidence validation', () => {
  it.each([
    [
      'unknown question',
      (value: UrsAnswerSuggestions) => {
        value.suggestions[0].question_id = 'INVENTED';
      },
    ],
    [
      'omitted question',
      (value: UrsAnswerSuggestions) => {
        value.suggestions = [];
      },
    ],
    [
      'duplicate question',
      (value: UrsAnswerSuggestions) => {
        value.suggestions.push(structuredClone(value.suggestions[0]));
      },
    ],
    [
      'invented source',
      (value: UrsAnswerSuggestions) => {
        value.suggestions[0].citations[0].source = 'unseen';
      },
    ],
    [
      'invented location',
      (value: UrsAnswerSuggestions) => {
        value.suggestions[0].citations[0].location = 'missing.md';
      },
    ],
    [
      'unsupported default',
      (value: UrsAnswerSuggestions) => {
        value.suggestions[0].basis = 'decision';
      },
    ],
    [
      'uncited default',
      (value: UrsAnswerSuggestions) => {
        value.suggestions[0].citations = [];
      },
    ],
    [
      'duplicate alternatives',
      (value: UrsAnswerSuggestions) => {
        value.suggestions[0].choices = ['Same', 'Same'];
      },
    ],
  ])('rejects %s instead of presenting it as an accepted answer', async (_name, mutate) => {
    const value = suggestions();
    mutate(value);
    const urs = document();
    const result = await suggestUrsAnswers({
      root: '/tmp',
      provider: 'openai',
      key: 'test-key',
      urs,
      context,
      fetchImpl: transport('openai', [value]),
    });
    expect(result.incomplete).toBe(true);
    expect(result.value).toBeUndefined();
    expect(urs.open_questions[0].answer).toBeNull();
  });

  it('allows only existing URS references and never model-authored approval metadata', () => {
    const value = suggestions();
    value.suggestions[0].citations = [{ source: '@urs', location: 'requirement:URS-CSV' }];
    expect(validateUrsAnswerSuggestions(document(), value, { context })).toEqual(value);
    value.suggestions[0].citations[0].location = 'requirement:INVENTED';
    expect(() => validateUrsAnswerSuggestions(document(), value, { context })).toThrow(
      'not supplied',
    );
    expect(() =>
      validateUrsAnswerSuggestions(document(), { ...suggestions(), resolution: {} }, { context }),
    ).toThrow();
  });

  it('rejects invalid question selections before dispatch', async () => {
    const requests = transport('openai', []);
    await expect(
      suggestUrsAnswers({
        root: '/tmp',
        provider: 'openai',
        key: 'test-key',
        urs: document(),
        questionIds: ['missing'],
        fetchImpl: requests,
      }),
    ).rejects.toThrow('Unknown question');
    expect(requests).not.toHaveBeenCalled();
    expect(() => answerSuggestionQuestions(document(), ['Q-CSV', 'Q-CSV'])).toThrow('duplicate');
  });
});

function answeredDocument() {
  const urs = document();
  urs.open_questions[0].answer = 'Download a header-only CSV with no data rows.';
  return urs;
}
function reviewedProposal(urs: Urs): UrsResolutionProposal {
  return {
    requirements: [
      {
        question_ids: [urs.open_questions[0].id],
        value: {
          ...structuredClone(urs.families[0].requirements[0]),
          statement: 'Download a header-only CSV when the register is empty.',
        },
        reason: 'Incorporate the recorded empty-export decision.',
      },
    ],
    unresolved: [],
  };
}
const resolutionOptions = {
  root: '/tmp',
  provider: 'openai' as const,
  key: 'test-key',
  context,
};

describe('bounded answer-resolution correction', () => {
  it.each(['openai', 'anthropic'] as const)(
    'corrects a contradictory question outcome before presenting a review with %s',
    async (provider) => {
      const urs = answeredDocument();
      urs.open_questions[0].id = 'DB-Q-01';
      const original = structuredClone(urs);
      const proposal = reviewedProposal(urs);
      const contradictory = {
        ...proposal,
        unresolved: [
          { question_id: 'DB-Q-01', reason: 'AMBIGUOUS-RESOLUTION: supply the missing decision.' },
        ],
      };
      const requests = transport(provider, [contradictory, resolutionProviderValue(proposal)]);
      const result = await proposeUrsResolution({
        ...resolutionOptions,
        provider,
        urs,
        fetchImpl: requests,
      });
      expect(result.incomplete).toBe(false);
      expect(result.value).toEqual(proposal);
      expect(requests).toHaveBeenCalledTimes(2);
      expect(result.diagnostics?.some((item) => item.kind === 'document_schema')).toBe(true);
      expect(JSON.stringify(result.diagnostics)).toContain('AMBIGUOUS-RESOLUTION');
      expect(String(requests.mock.calls[1][1]?.body)).toContain('AMBIGUOUS-RESOLUTION');
      expect(urs).toEqual(original);
      expect(questionStatus(urs, urs.open_questions[0])).toBe('answered');
    },
  );

  it('repairs a semantic target mismatch and retains the rejected proposal for diagnosis', async () => {
    const urs = answeredDocument();
    urs.families[0].requirements.push({ ...urs.families[0].requirements[0], id: 'URS-OTHER' });
    const original = structuredClone(urs);
    const proposal = reviewedProposal(urs);
    const wrong = resolutionProviderValue(proposal);
    wrong.questions['Q-CSV'] = {
      status: 'resolved',
      requirement_ids: ['URS-CSV', 'URS-OTHER'],
      document: false,
    };
    const requests = transport('openai', [wrong, resolutionProviderValue(proposal)]);
    const result = await proposeUrsResolution({ ...resolutionOptions, urs, fetchImpl: requests });
    expect(result.incomplete).toBe(false);
    expect(result.value).toEqual(proposal);
    expect(requests).toHaveBeenCalledTimes(2);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'urs_resolution' })]),
    );
    expect(JSON.stringify(result.diagnostics)).toContain('URS-OTHER');
    expect(String(requests.mock.calls[1][1]?.body)).toContain('proposed replacement');
    expect(urs).toEqual(original);
  });

  it('stops after two corrections while retaining all answers and unresolved diagnostics', async () => {
    const urs = answeredDocument();
    const original = structuredClone(urs);
    const wrong = resolutionProviderValue(reviewedProposal(urs));
    wrong.requirements = [];
    const requests = transport('openai', [wrong, wrong, wrong]);
    const result = await proposeUrsResolution({ ...resolutionOptions, urs, fetchImpl: requests });
    expect(result.incomplete).toBe(true);
    expect(result.value).toBeUndefined();
    expect(requests).toHaveBeenCalledTimes(3);
    expect(result.questions.join(' ')).toMatch(
      /correction.*limit|could not correct|after two corrections/i,
    );
    expect(result.diagnostics?.filter((item) => item.kind === 'urs_resolution')).toHaveLength(3);
    expect(urs).toEqual(original);
  });

  it('shares the correction ceiling across proposal rounds in the same command', async () => {
    const urs = answeredDocument();
    const proposal = reviewedProposal(urs);
    const wrong = resolutionProviderValue(proposal);
    wrong.requirements = [];
    const requests = transport('openai', [wrong, resolutionProviderValue(proposal), wrong]);
    const resolutionRepairs = { used: 1 };
    const budget = new Budget(15);
    const options = { ...resolutionOptions, urs, fetchImpl: requests, resolutionRepairs, budget };
    const first = await proposeUrsResolution(options);
    expect(first.incomplete).toBe(false);
    expect(resolutionRepairs.used).toBe(2);
    const second = await proposeUrsResolution(options);
    expect(second.incomplete).toBe(true);
    expect(requests).toHaveBeenCalledTimes(3);
    expect(second.spend.calls).toBe(3);
    expect(resolutionRepairs.used).toBe(2);
  });

  it('offers eight independent answers for review while asking only for the missing decision', async () => {
    const urs = answeredDocument();
    urs.open_questions = Array.from({ length: 9 }, (_, index) => ({
      id: `DB-Q-${String(index + 1).padStart(2, '0')}`,
      requirement: 'URS-CSV',
      question: `Which export behavior applies to case ${index + 1}?`,
      answer:
        index === 0 ? 'Use explicit limits.' : 'Download a header-only CSV with no data rows.',
    }));
    const original = structuredClone(urs);
    const proposal = reviewedProposal(urs);
    proposal.requirements[0].question_ids = urs.open_questions
      .slice(1)
      .map((question) => question.id);
    proposal.unresolved = [
      {
        question_id: 'DB-Q-01',
        reason: 'What exact minimum and maximum values should be accepted?',
      },
    ];
    const requests = transport('openai', [resolutionProviderValue(proposal)]);
    const result = await proposeUrsResolution({ ...resolutionOptions, urs, fetchImpl: requests });
    expect(result.incomplete).toBe(false);
    expect(result.value).toEqual(proposal);
    expect(result.questions).toContain(
      'DB-Q-01: What exact minimum and maximum values should be accepted?',
    );
    expect(requests).toHaveBeenCalledOnce();
    expect(urs).toEqual(original);
    const reviewed = applyResolutionProposal(urs, result.value);
    expect(
      reviewed.open_questions.filter(
        (question) => questionStatus(reviewed, question) === 'resolved',
      ),
    ).toHaveLength(8);
    expect(pendingAnsweredQuestions(reviewed).map((question) => question.id)).toEqual(['DB-Q-01']);
    expect(reviewed.open_questions.map((question) => question.answer)).toEqual(
      original.open_questions.map((question) => question.answer),
    );
  });

  it.each(['http', 'refusal', 'incomplete'] as const)(
    'does not use document corrections for a provider %s failure',
    async (failure) => {
      const urs = answeredDocument();
      const original = structuredClone(urs);
      const requests = vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              failure === 'http'
                ? { error: { type: 'invalid_request_error', message: 'Schema rejected.' } }
                : {
                    status: failure === 'incomplete' ? 'incomplete' : 'completed',
                    output: [{ type: 'refusal' }],
                  },
            ),
            { status: failure === 'http' ? 400 : 200 },
          ),
      );
      const resolutionRepairs = { used: 0 };
      const result = await proposeUrsResolution({
        ...resolutionOptions,
        urs,
        resolutionRepairs,
        fetchImpl: requests,
      });
      expect(result.incomplete).toBe(true);
      expect(result.value).toBeUndefined();
      expect(requests).toHaveBeenCalledOnce();
      expect(resolutionRepairs.used).toBe(0);
      expect(urs).toEqual(original);
    },
  );
});
