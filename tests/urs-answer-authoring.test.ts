import { providerOutputText } from './provider-fixture.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Budget, proposeUrsResolution, suggestUrsAnswers } from '../src/authoring/index.js';
import { ursSchema } from '../src/schema.js';
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
    const requests = transport('openai', [suggestions(), proposal]);
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
