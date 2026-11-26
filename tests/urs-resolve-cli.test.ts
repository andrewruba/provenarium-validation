import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import { ursSchema, type Urs } from '../src/schema.js';
import { loadUrs, pendingAnsweredQuestions, questionStatus } from '../src/urs.js';
import { applyResolutionProposal, type UrsResolutionProposal } from '../src/urs-resolution.js';
import { resolveUrsFile } from '../src/urs-resolve-cli.js';
import type { UrsAnswerSuggestions } from '../src/urs-answers.js';
import type { AuthoringResult } from '../src/authoring/index.js';

const roots: string[] = [];
const answer = 'Download a header-only CSV with no data rows.';
const decidedStatement = 'An empty export shall contain column headings and no data rows.';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function document(): Urs {
  return ursSchema.parse({
    schema_version: 1,
    document: {
      id: 'URS-DEMO',
      revision: '1',
      title: 'Preparation register',
      intended_use: 'Exercise a synthetic preparation register.',
    },
    families: [
      {
        id: 'records',
        title: 'Records and export',
        requirements: [
          { id: 'URS-CSV', title: 'CSV export', statement: 'Provide a CSV export.' },
          { id: 'URS-CLEAR', title: 'Clear records', statement: 'Provide a clear action.' },
        ],
      },
    ],
    open_questions: [
      { id: 'Q-CSV', requirement: 'URS-CSV', question: 'What should an empty export contain?' },
      {
        id: 'Q-CLEAR',
        requirement: 'URS-CLEAR',
        question: 'Should clearing require confirmation?',
      },
    ],
  });
}

async function fixture(manualAnswer = false) {
  const root = await mkdtemp(join(tmpdir(), 'provenarium resolve '));
  roots.push(root);
  const urs = document();
  if (manualAnswer) urs.open_questions[0].answer = answer;
  const file = join(root, 'urs.yaml');
  const original = `# Keep this human note.\n${stringify(urs)}`;
  await writeFile(file, original);
  return { root, file, urs, original };
}

function proposal(urs: Urs): UrsResolutionProposal {
  return {
    requirements: pendingAnsweredQuestions(urs).map((question) => ({
      question_ids: [question.id],
      value: {
        ...urs.families
          .flatMap((family) => family.requirements)
          .find((r) => r.id === question.requirement)!,
        statement: question.id === 'Q-CSV' ? decidedStatement : question.answer!.trim(),
      },
      reason: `Incorporate the recorded answer to ${question.id}.`,
    })),
    unresolved: [],
  };
}

function runtime(isTTY = true) {
  const logs: string[] = [];
  return {
    isTTY,
    text: vi.fn<(...args: unknown[]) => Promise<string | symbol>>().mockResolvedValue(''),
    confirm: vi.fn<(...args: unknown[]) => Promise<boolean | symbol>>().mockResolvedValue(false),
    log: (value: string) => logs.push(value),
    logs,
    propose: vi.fn(async (urs: Urs) => ({
      value: proposal(urs),
      incomplete: false,
      questions: [],
      spend: { cap: 15, actual: 0, reserved: 0, calls: 0 },
      reviewRounds: 0,
    })),
  };
}

function suggestionRuntime(isTTY = true) {
  return {
    ...runtime(isTTY),
    select: vi.fn<(...args: unknown[]) => Promise<string | symbol>>().mockResolvedValue('skip'),
    suggest: vi.fn<
      (urs: Urs, questionIds: string[]) => Promise<AuthoringResult<UrsAnswerSuggestions>>
    >(async (_urs, questionIds) => ({
      value: {
        suggestions: questionIds.map((question_id) =>
          question_id === 'Q-CSV'
            ? {
                question_id,
                answer,
                basis: 'documented' as const,
                explanation: 'The design specifies a header-only file when the register is empty.',
                citations: [{ source: 'design', location: 'design.md' }],
                choices: [],
              }
            : {
                question_id,
                answer: null,
                basis: 'decision' as const,
                explanation: 'The context does not decide whether clearing needs confirmation.',
                citations: [],
                choices: [
                  'Require confirmation before clearing.',
                  'Clear immediately without confirmation.',
                ],
              },
        ),
      } satisfies UrsAnswerSuggestions,
      incomplete: false,
      questions: [],
      spend: { cap: 15, actual: 0, reserved: 0, calls: 1 },
      reviewRounds: 0,
    })),
  };
}

async function savedProposal(root: string) {
  const directory = join(root, '.provenarium', 'resolutions');
  const files = (await readdir(directory)).filter((name) => name.endsWith('.proposal.json'));
  expect(files).toHaveLength(1);
  return join(directory, files[0]);
}

it('captures answers beside questions, preserves notes, and can stop before any provider request', async () => {
  const f = await fixture();
  const ui = runtime();
  ui.text.mockResolvedValueOnce(answer).mockResolvedValueOnce('');

  await resolveUrsFile({ root: f.root, file: 'urs.yaml', answersOnly: true }, ui);

  const saved = await loadUrs(f.file);
  expect(saved.open_questions[0].answer).toBe(answer);
  expect(questionStatus(saved, saved.open_questions[0])).toBe('answered');
  expect(questionStatus(saved, saved.open_questions[1])).toBe('unanswered');
  expect(saved.families).toEqual(f.urs.families);
  expect(ui.propose).not.toHaveBeenCalled();
  expect(ui.confirm).not.toHaveBeenCalled();
  expect(await readFile(f.file, 'utf8')).toContain('# Keep this human note.');
  const history = join(f.root, '.provenarium', 'resolutions');
  const snapshots = await Promise.all(
    (await readdir(history))
      .filter((name) => name.endsWith('.yaml'))
      .map((name) => readFile(join(history, name), 'utf8')),
  );
  expect(snapshots).toContain(f.original);
});

it('retains earlier answers when the user cancels and resumes at the unanswered question', async () => {
  const f = await fixture();
  const first = runtime();
  first.text.mockResolvedValueOnce(answer).mockResolvedValueOnce(Symbol('cancel'));
  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, first);
  expect(first.propose).not.toHaveBeenCalled();
  expect((await loadUrs(f.file)).open_questions[0].answer).toBe(answer);

  const resumed = runtime();
  resumed.text.mockResolvedValueOnce('Require confirmation before clearing.');
  await resolveUrsFile({ root: f.root, file: 'urs.yaml', answersOnly: true }, resumed);
  expect(resumed.text).toHaveBeenCalledOnce();
  expect(resumed.logs[0]).toMatch(/^Q-CLEAR:/);
  expect((await loadUrs(f.file)).open_questions.map((q) => q.answer)).toEqual([
    answer,
    'Require confirmation before clearing.',
  ]);
});

it('uses answers entered directly in YAML and shows requirement changes before applying them', async () => {
  const f = await fixture(true);
  const ui = runtime();
  ui.confirm.mockResolvedValueOnce(true);

  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);

  expect(ui.text).toHaveBeenCalledOnce();
  expect(ui.logs[0]).toMatch(/^Q-CLEAR:/);
  expect(ui.propose).toHaveBeenCalledOnce();
  expect(ui.propose.mock.calls[0][0].open_questions[0].answer).toBe(answer);
  expect(ui.logs.join('\n')).toContain('Before:');
  expect(ui.logs.join('\n')).toContain('Provide a CSV export.');
  expect(ui.logs.join('\n')).toContain(decidedStatement);
  expect(ui.confirm).toHaveBeenCalledOnce();
  const saved = await loadUrs(f.file);
  expect(saved.families[0].requirements[0].statement).toBe(decidedStatement);
  expect(saved.families[0].requirements[1]).toEqual(f.urs.families[0].requirements[1]);
  expect(saved.open_questions).toHaveLength(2);
  expect(saved.open_questions[0].answer).toBe(answer);
  expect(questionStatus(saved, saved.open_questions[0])).toBe('resolved');
  expect(questionStatus(saved, saved.open_questions[1])).toBe('unanswered');
  expect(saved.document.revision).not.toBe(f.urs.document.revision);
});

it('keeps answers and the original requirements when proposed changes are declined', async () => {
  const f = await fixture(true);
  const ui = runtime();
  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);

  const saved = await loadUrs(f.file);
  expect(saved.families).toEqual(f.urs.families);
  expect(saved.document.revision).toBe('1');
  expect(saved.open_questions[0].answer).toBe(answer);
  expect(questionStatus(saved, saved.open_questions[0])).toBe('answered');
  expect(await savedProposal(f.root)).toBeTruthy();
  expect(ui.logs.at(-1)).toContain('without another AI call:');
  expect(ui.logs.join('\n')).not.toContain('Check requirements:');
});

it('resumes failed proposal authoring with saved answers instead of directing the user to check', async () => {
  const f = await fixture(true);
  const ui = runtime();
  ui.propose.mockResolvedValueOnce({
    value: undefined as unknown as UrsResolutionProposal,
    incomplete: true,
    questions: ['Question Q-CSV cannot be both resolved and unresolved.'],
    spend: { cap: 15, actual: 0, reserved: 0, calls: 1 },
    reviewRounds: 0,
  });

  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);

  const saved = await loadUrs(f.file);
  expect(saved.open_questions[0].answer).toBe(answer);
  expect(saved.families).toEqual(f.urs.families);
  expect(ui.logs.join('\n')).toContain('1 answers saved, requirement review pending');
  expect(ui.logs.at(-1)).toMatch(/Resume requirement review.*urs resolve/);
  expect(ui.logs.join('\n')).not.toContain('Check requirements:');
  expect(ui.confirm).not.toHaveBeenCalled();
});

function needsClearClarification(urs: Urs): UrsResolutionProposal {
  const value = proposal(urs);
  value.requirements = value.requirements.filter((change) => change.value.id === 'URS-CSV');
  value.unresolved = [
    { question_id: 'Q-CLEAR', reason: 'Choose immediate clearing or a confirmation step.' },
  ];
  return value;
}

it('reviews ready answers, asks only the specific missing detail, and reviews the clarification in the same command', async () => {
  const f = await fixture(true);
  f.urs.open_questions[1].answer = 'Use the appropriate clearing workflow.';
  await writeFile(f.file, stringify(f.urs));
  const ui = suggestionRuntime();
  ui.propose.mockImplementationOnce(async (urs) => ({
    value: needsClearClarification(urs),
    incomplete: false,
    questions: [],
    spend: { cap: 15, actual: 0, reserved: 0, calls: 1 },
    reviewRounds: 0,
  }));
  ui.confirm.mockResolvedValue(true);
  ui.text.mockResolvedValueOnce('Require confirmation before clearing.');

  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);

  expect(ui.suggest).not.toHaveBeenCalled();
  expect(ui.select).not.toHaveBeenCalled();
  expect(ui.text).toHaveBeenCalledOnce();
  expect(ui.text.mock.calls[0][0]).toMatchObject({
    message: expect.stringContaining('Q-CLEAR'),
    initialValue: 'Use the appropriate clearing workflow.',
  });
  expect(ui.propose).toHaveBeenCalledTimes(2);
  const followup = ui.propose.mock.calls[1][0];
  expect(pendingAnsweredQuestions(followup).map((question) => question.id)).toEqual(['Q-CLEAR']);
  expect(followup.open_questions[0].answer).toBe(answer);
  expect(followup.open_questions[1].answer).toBe('Require confirmation before clearing.');
  expect(ui.confirm).toHaveBeenCalledTimes(2);
  const saved = await loadUrs(f.file);
  expect(saved.open_questions.map((question) => questionStatus(saved, question))).toEqual([
    'resolved',
    'resolved',
  ]);
  expect(saved.open_questions[0].answer).toBe(answer);
  expect(ui.logs.at(-1)).toContain('Check requirements:');
});

it('bounds clarification to one follow-up proposal and prints a targeted continuation', async () => {
  const f = await fixture(true);
  f.urs.open_questions = [f.urs.open_questions[1]];
  f.urs.open_questions[0].answer = 'Use the appropriate clearing workflow.';
  await writeFile(f.file, stringify(f.urs));
  const ui = runtime();
  ui.propose.mockImplementation(async (urs) => ({
    value: needsClearClarification(urs),
    incomplete: false,
    questions: [],
    spend: { cap: 15, actual: 0, reserved: 0, calls: 1 },
    reviewRounds: 0,
  }));
  ui.text.mockResolvedValueOnce('Use confirmation when appropriate.');

  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);

  expect(ui.propose).toHaveBeenCalledTimes(2);
  expect(ui.text).toHaveBeenCalledOnce();
  expect(ui.confirm).not.toHaveBeenCalled();
  expect((await loadUrs(f.file)).open_questions[0].answer).toBe(
    'Use confirmation when appropriate.',
  );
  expect(ui.logs.at(-1)).toMatch(/urs resolve .*--question Q-CLEAR/);
  expect(ui.logs.join('\n')).not.toContain('Check requirements:');
});

it('keeps reviewed changes when clarification is cancelled and does not request another proposal', async () => {
  const f = await fixture(true);
  f.urs.open_questions[1].answer = 'Use the appropriate clearing workflow.';
  await writeFile(f.file, stringify(f.urs));
  const ui = runtime();
  ui.propose.mockImplementationOnce(async (urs) => ({
    value: needsClearClarification(urs),
    incomplete: false,
    questions: [],
    spend: { cap: 15, actual: 0, reserved: 0, calls: 1 },
    reviewRounds: 0,
  }));
  ui.confirm.mockResolvedValueOnce(true);
  ui.text.mockResolvedValueOnce(Symbol('cancel'));

  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);

  const saved = await loadUrs(f.file);
  expect(saved.open_questions.map((question) => questionStatus(saved, question))).toEqual([
    'resolved',
    'answered',
  ]);
  expect(saved.open_questions[1].answer).toBe(f.urs.open_questions[1].answer);
  expect(ui.propose).toHaveBeenCalledOnce();
  expect(ui.logs.at(-1)).toMatch(/urs resolve .*--question Q-CLEAR/);
  expect(ui.logs.join('\n')).not.toContain('Check requirements:');
});

it.each([false, Symbol('cancel')])(
  'preserves the saved review when the user declines or cancels before clarification (%s)',
  async (confirmation) => {
    const f = await fixture(true);
    f.urs.open_questions[1].answer = 'Use the appropriate clearing workflow.';
    await writeFile(f.file, stringify(f.urs));
    const ui = runtime();
    ui.propose.mockImplementationOnce(async (urs) => ({
      value: needsClearClarification(urs),
      incomplete: false,
      questions: [],
      spend: { cap: 15, actual: 0, reserved: 0, calls: 1 },
      reviewRounds: 0,
    }));
    ui.confirm.mockResolvedValueOnce(confirmation);

    await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);

    expect(ui.text).not.toHaveBeenCalled();
    expect(ui.propose).toHaveBeenCalledOnce();
    expect(await savedProposal(f.root)).toBeTruthy();
    const saved = await loadUrs(f.file);
    expect(saved.families).toEqual(f.urs.families);
    expect(saved.open_questions.map((question) => questionStatus(saved, question))).toEqual([
      'answered',
      'answered',
    ]);
    expect(ui.logs.at(-1)).toMatch(/without another AI call:.*--apply/);
    expect(ui.logs.join('\n')).not.toContain('Check requirements:');
  },
);

it('keeps partial saved-proposal application offline and directs only unresolved questions back to resolve', async () => {
  const f = await fixture(true);
  f.urs.open_questions[1].answer = 'Use the appropriate clearing workflow.';
  await writeFile(f.file, stringify(f.urs));
  const first = runtime(false);
  first.propose.mockImplementationOnce(async (urs) => ({
    value: needsClearClarification(urs),
    incomplete: false,
    questions: [],
    spend: { cap: 15, actual: 0, reserved: 0, calls: 1 },
    reviewRounds: 0,
  }));
  await resolveUrsFile({ root: f.root, file: 'urs.yaml', yes: true }, first);
  const apply = await savedProposal(f.root);
  const offline = runtime(false);

  await resolveUrsFile({ root: f.root, file: 'urs.yaml', apply, yes: true }, offline);

  expect(offline.propose).not.toHaveBeenCalled();
  expect(offline.text).not.toHaveBeenCalled();
  expect(offline.logs.at(-1)).toMatch(/urs resolve .*--question Q-CLEAR/);
  expect(offline.logs.join('\n')).not.toContain('Check requirements:');
});

it('does not spend on a follow-up proposal if the saved answer is unchanged', async () => {
  const f = await fixture(true);
  f.urs.open_questions = [f.urs.open_questions[1]];
  f.urs.open_questions[0].answer = 'Use the appropriate clearing workflow.';
  await writeFile(f.file, stringify(f.urs));
  const ui = runtime();
  ui.propose.mockImplementationOnce(async (urs) => ({
    value: needsClearClarification(urs),
    incomplete: false,
    questions: [],
    spend: { cap: 15, actual: 0, reserved: 0, calls: 1 },
    reviewRounds: 0,
  }));
  ui.text.mockResolvedValueOnce(f.urs.open_questions[0].answer);

  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);

  expect(ui.propose).toHaveBeenCalledOnce();
  expect(ui.text).toHaveBeenCalledOnce();
  expect(ui.logs.at(-1)).toMatch(/urs resolve .*--question Q-CLEAR/);
});

it('applies reviewed answers while preserving answers that still need clarification', async () => {
  const f = await fixture(true);
  f.urs.open_questions[1].answer = 'I am not sure whether confirmation is required.';
  await writeFile(f.file, stringify(f.urs));
  const ui = runtime();
  ui.confirm.mockResolvedValueOnce(true);
  ui.propose.mockImplementationOnce(async (urs) => {
    const value = proposal(urs);
    value.requirements = value.requirements.filter((change) => change.value.id === 'URS-CSV');
    value.unresolved = [
      { question_id: 'Q-CLEAR', reason: 'Choose immediate clearing or a confirmation step.' },
    ];
    return {
      value,
      incomplete: false,
      questions: ['Choose immediate clearing or a confirmation step.'],
      spend: { cap: 15, actual: 0, reserved: 0, calls: 0 },
      reviewRounds: 0,
    };
  });

  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);

  const saved = await loadUrs(f.file);
  expect(saved.open_questions.map((question) => questionStatus(saved, question))).toEqual([
    'resolved',
    'answered',
  ]);
  expect(saved.open_questions[1]).toEqual(f.urs.open_questions[1]);
  expect(saved.families[0].requirements[1]).toEqual(f.urs.families[0].requirements[1]);
  expect(ui.logs.join('\n')).toContain('Choose immediate clearing or a confirmation step.');
});

it('does not silently apply fresh suggestions when --yes accepts the provider preview', async () => {
  const f = await fixture(true);
  const ui = runtime(false);
  await resolveUrsFile({ root: f.root, file: 'urs.yaml', yes: true }, ui);

  expect(ui.propose).toHaveBeenCalledOnce();
  expect(ui.text).not.toHaveBeenCalled();
  expect(ui.confirm).not.toHaveBeenCalled();
  expect((await loadUrs(f.file)).families).toEqual(f.urs.families);
  expect(await savedProposal(f.root)).toBeTruthy();
});

it('applies an explicitly selected saved proposal without another provider request', async () => {
  const f = await fixture(true);
  await resolveUrsFile({ root: f.root, file: 'urs.yaml', yes: true }, runtime(false));
  const apply = await savedProposal(f.root);
  const ui = runtime(false);

  await resolveUrsFile({ root: f.root, file: 'urs.yaml', apply, yes: true }, ui);

  expect(ui.propose).not.toHaveBeenCalled();
  expect(ui.text).not.toHaveBeenCalled();
  expect(ui.confirm).not.toHaveBeenCalled();
  expect(ui.logs.join('\n')).toContain(decidedStatement);
  const saved = await loadUrs(f.file);
  expect(questionStatus(saved, saved.open_questions[0])).toBe('resolved');
  expect(saved.families[0].requirements[0].statement).toBe(decidedStatement);
});

it('rejects a stale saved proposal instead of overwriting later file edits', async () => {
  const f = await fixture(true);
  await resolveUrsFile({ root: f.root, file: 'urs.yaml', yes: true }, runtime(false));
  const apply = await savedProposal(f.root);
  const edited = `${await readFile(f.file, 'utf8')}\n# A later human edit\n`;
  await writeFile(f.file, edited);

  await expect(
    resolveUrsFile({ root: f.root, file: 'urs.yaml', apply, yes: true }, runtime(false)),
  ).rejects.toThrow(/changed|stale|match/i);
  expect(await readFile(f.file, 'utf8')).toBe(edited);
});

it('rechecks the source after review so concurrent edits are preserved', async () => {
  const f = await fixture(true);
  const ui = runtime();
  let concurrent = '';
  ui.confirm.mockImplementationOnce(async () => {
    concurrent = `${await readFile(f.file, 'utf8')}\n# Edited during review\n`;
    await writeFile(f.file, concurrent);
    return true;
  });

  await expect(resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui)).rejects.toThrow(
    /changed|stale|match/i,
  );
  expect(await readFile(f.file, 'utf8')).toBe(concurrent);
});

it('rejects a proposal that invents a requirement without changing the working URS', async () => {
  const f = await fixture(true);
  const ui = runtime(false);
  ui.propose.mockImplementationOnce(async (urs) => {
    const value = proposal(urs);
    value.requirements[0].value.id = 'URS-INVENTED';
    return {
      value,
      incomplete: false,
      questions: [],
      spend: { cap: 15, actual: 0, reserved: 0, calls: 0 },
      reviewRounds: 0,
    };
  });

  await expect(resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui)).rejects.toThrow(
    /does not exist|unknown/i,
  );
  const saved = await loadUrs(f.file);
  expect(saved.families).toEqual(f.urs.families);
  expect(questionStatus(saved, saved.open_questions[0])).toBe('answered');
  expect(ui.confirm).not.toHaveBeenCalled();
});

it('skips retained resolved questions without prompting or generating another proposal', async () => {
  const f = await fixture(true);
  f.urs.open_questions = [f.urs.open_questions[0]];
  const resolved = applyResolutionProposal(f.urs, proposal(f.urs));
  await writeFile(f.file, stringify(resolved));
  const ui = runtime();

  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);

  expect(ui.text).not.toHaveBeenCalled();
  expect(ui.propose).not.toHaveBeenCalled();
  expect(ui.confirm).not.toHaveBeenCalled();
  expect((await loadUrs(f.file)).open_questions).toEqual(resolved.open_questions);
});

it('lets the user explicitly revise a retained answer and requires review again', async () => {
  const f = await fixture(true);
  f.urs.open_questions = [f.urs.open_questions[0]];
  const resolved = applyResolutionProposal(f.urs, proposal(f.urs));
  await writeFile(f.file, stringify(resolved));
  const ui = runtime();
  const revisedAnswer = 'Show a no-records message without downloading a file.';
  ui.text.mockResolvedValueOnce(revisedAnswer);

  await resolveUrsFile(
    { root: f.root, file: 'urs.yaml', questions: ['Q-CSV'], answersOnly: true },
    ui,
  );

  expect(ui.text).toHaveBeenCalledOnce();
  expect(ui.text.mock.calls[0][0]).toMatchObject({ initialValue: answer });
  expect(ui.propose).not.toHaveBeenCalled();
  const saved = await loadUrs(f.file);
  expect(saved.open_questions[0].answer).toBe(revisedAnswer);
  expect(questionStatus(saved, saved.open_questions[0])).toBe('answered');
  expect(saved.families).toEqual(resolved.families);
});

it.each(['packages/pkg-1/urs.yaml', 'candidates/candidate-1/urs.yaml', '.provenarium/urs.yaml'])(
  'refuses to mutate immutable or internal target %s',
  async (file) => {
    const f = await fixture(true);
    const target = join(f.root, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, f.original);
    const ui = runtime();

    await expect(resolveUrsFile({ root: f.root, file }, ui)).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe(f.original);
    expect(ui.text).not.toHaveBeenCalled();
    expect(ui.propose).not.toHaveBeenCalled();
  },
);

it.each(['approval.json', 'candidate.json'])(
  'refuses a package directory selected as the project root when %s exists',
  async (marker) => {
    const f = await fixture(true);
    await writeFile(join(f.root, marker), '{}');
    const ui = runtime();

    await expect(resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui)).rejects.toThrow();
    expect(await readFile(f.file, 'utf8')).toBe(f.original);
    expect(ui.propose).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  'refuses a project inside an approved package even through a symlink (%s)',
  async (linked) => {
    const f = await fixture(true);
    const approved = join(f.root, 'approved-package');
    const nested = join(approved, 'nested');
    await mkdir(nested, { recursive: true });
    await writeFile(join(approved, 'approval.json'), '{}');
    const target = join(nested, 'urs.yaml');
    await writeFile(target, f.original);
    let project = nested;
    if (linked) {
      project = join(f.root, 'project-link');
      await symlink(nested, project);
    }
    const ui = runtime();

    await expect(resolveUrsFile({ root: project, file: 'urs.yaml' }, ui)).rejects.toThrow();

    expect(await readFile(target, 'utf8')).toBe(f.original);
    expect(ui.text).not.toHaveBeenCalled();
    expect(ui.propose).not.toHaveBeenCalled();
  },
);

it('offers sourced answers for acceptance and retains the separate requirement review', async () => {
  const f = await fixture();
  const ui = suggestionRuntime();
  ui.select.mockResolvedValueOnce('accept').mockResolvedValueOnce('skip');

  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);

  expect(ui.suggest).toHaveBeenCalledOnce();
  expect(ui.suggest.mock.calls[0][1]).toEqual(['Q-CSV', 'Q-CLEAR']);
  expect(ui.text).not.toHaveBeenCalled();
  expect(ui.logs.join('\n')).toContain(answer);
  expect(ui.logs.join('\n')).toContain('design.md');
  expect(ui.logs.join('\n')).toContain('header-only file when the register is empty');
  expect(ui.propose).toHaveBeenCalledOnce();
  expect(ui.propose.mock.calls[0][0].open_questions[0].answer).toBe(answer);
  expect(ui.confirm).toHaveBeenCalledOnce();
  const saved = await loadUrs(f.file);
  expect(saved.open_questions[0].answer).toBe(answer);
  expect(saved.open_questions[1].answer).toBeNull();
  expect(saved.families).toEqual(f.urs.families);
  expect(questionStatus(saved, saved.open_questions[0])).toBe('answered');
});

it('prefills an editable suggestion and sends only the user-edited answer for proposal', async () => {
  const f = await fixture();
  const ui = suggestionRuntime();
  const edited = 'Do not download a file; explain that there are no saved preparations.';
  ui.select.mockResolvedValueOnce('edit').mockResolvedValueOnce('skip');
  ui.text.mockResolvedValueOnce(edited);

  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);

  expect(ui.text).toHaveBeenCalledOnce();
  expect(ui.text.mock.calls[0][0]).toMatchObject({ initialValue: answer });
  expect(ui.propose.mock.calls[0][0].open_questions[0].answer).toBe(edited);
  expect((await loadUrs(f.file)).open_questions[0].answer).toBe(edited);
});

it('lets a reviewer choose a concrete alternative where context cannot establish a default', async () => {
  const f = await fixture();
  const ui = suggestionRuntime();
  ui.select.mockResolvedValueOnce('skip').mockResolvedValueOnce('choice:0');

  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);

  expect(ui.text).not.toHaveBeenCalled();
  const choices = ui.select.mock.calls[1][0] as {
    options: { value: string; label: string }[];
  };
  expect(choices.options.map((option) => option.value)).not.toContain('accept');
  expect(choices.options).toContainEqual(
    expect.objectContaining({ value: 'choice:0', label: 'Require confirmation before clearing.' }),
  );
  const saved = await loadUrs(f.file);
  expect(saved.open_questions[0].answer).toBeNull();
  expect(saved.open_questions[1].answer).toBe('Require confirmation before clearing.');
  expect(ui.propose.mock.calls[0][0].open_questions[1].answer).toBe(
    'Require confirmation before clearing.',
  );
});

it('leaves all suggested answers unaccepted when the reviewer skips them', async () => {
  const f = await fixture();
  const ui = suggestionRuntime();

  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);

  expect(ui.suggest).toHaveBeenCalledOnce();
  expect(ui.propose).not.toHaveBeenCalled();
  expect(ui.confirm).not.toHaveBeenCalled();
  const saved = await loadUrs(f.file);
  expect(saved.open_questions.map((question) => question.answer)).toEqual([null, null]);
  expect(saved.families).toEqual(f.urs.families);
});

it('saves accepted answers before cancellation and suggests only the remaining questions on resume', async () => {
  const f = await fixture();
  const first = suggestionRuntime();
  first.select.mockResolvedValueOnce('accept').mockResolvedValueOnce(Symbol('cancel'));

  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, first);

  expect(first.propose).not.toHaveBeenCalled();
  expect((await loadUrs(f.file)).open_questions[0].answer).toBe(answer);
  const resumed = suggestionRuntime();
  resumed.select.mockResolvedValueOnce('choice:1');
  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, resumed);
  expect(resumed.suggest.mock.calls[0][1]).toEqual(['Q-CLEAR']);
  expect((await loadUrs(f.file)).open_questions.map((question) => question.answer)).toEqual([
    answer,
    'Clear immediately without confirmation.',
  ]);
});

it('falls back to manual answers visibly when suggestions cannot be produced', async () => {
  const f = await fixture();
  const ui = suggestionRuntime();
  ui.suggest.mockResolvedValueOnce({
    incomplete: true,
    questions: ['The provider request did not complete.'],
    spend: { cap: 15, actual: 0, reserved: 0, calls: 1 },
    reviewRounds: 0,
  });
  ui.text.mockResolvedValueOnce(answer).mockResolvedValueOnce('');

  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);

  expect(ui.select).not.toHaveBeenCalled();
  expect(ui.text).toHaveBeenCalledTimes(2);
  expect(ui.logs.join('\n')).toMatch(/suggested answers.*unavailable|manual/i);
  expect(ui.propose.mock.calls[0][0].open_questions[0].answer).toBe(answer);
  expect((await loadUrs(f.file)).open_questions[1].answer).toBeNull();
});

it.each([{ answersOnly: true }, { yes: true }])(
  'does not request or accept model answers in offline or unattended mode: %j',
  async (options) => {
    const f = await fixture();
    const ui = suggestionRuntime();

    await resolveUrsFile({ root: f.root, file: 'urs.yaml', ...options }, ui);

    expect(ui.suggest).not.toHaveBeenCalled();
    expect(ui.select).not.toHaveBeenCalled();
    expect(ui.propose).not.toHaveBeenCalled();
    expect((await loadUrs(f.file)).open_questions.map((question) => question.answer)).toEqual([
      null,
      null,
    ]);
  },
);

it('preserves concurrent edits made while answer suggestions are being generated', async () => {
  const f = await fixture();
  const ui = suggestionRuntime();
  let concurrent = '';
  const suggest = ui.suggest.getMockImplementation()!;
  ui.suggest.mockImplementationOnce(async (urs, ids) => {
    concurrent = `${await readFile(f.file, 'utf8')}\n# Edited during suggestion generation\n`;
    await writeFile(f.file, concurrent);
    return suggest(urs, ids);
  });

  await expect(resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui)).rejects.toThrow(
    /changed|stale|match/i,
  );

  expect(ui.select).not.toHaveBeenCalled();
  expect(ui.propose).not.toHaveBeenCalled();
  expect(await readFile(f.file, 'utf8')).toBe(concurrent);
});

it('rejects malformed working requirements before requesting suggestions or proposals', async () => {
  const f = await fixture();
  f.urs.families[0].requirements[0].references = ['OQ-MISSING'];
  const original = stringify(f.urs);
  await writeFile(f.file, original);
  const ui = suggestionRuntime();

  await expect(resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui)).rejects.toThrow(
    /structural issues.*before AI resolution/s,
  );

  expect(ui.suggest).not.toHaveBeenCalled();
  expect(ui.propose).not.toHaveBeenCalled();
  expect(ui.select).not.toHaveBeenCalled();
  expect(await readFile(f.file, 'utf8')).toBe(original);
});

it('cannot use saved --apply to introduce an invalid reference into the working requirements', async () => {
  const f = await fixture(true);
  await resolveUrsFile({ root: f.root, file: 'urs.yaml', yes: true }, runtime(false));
  const apply = await savedProposal(f.root);
  const artifact = JSON.parse(await readFile(apply, 'utf8'));
  artifact.proposal.requirements[0].value.references = ['../outside-project.csv'];
  await writeFile(apply, JSON.stringify(artifact));
  const original = await readFile(f.file, 'utf8');
  const ui = suggestionRuntime(false);

  await expect(
    resolveUrsFile({ root: f.root, file: 'urs.yaml', apply, yes: true }, ui),
  ).rejects.toThrow(/failed structural validation/);

  expect(ui.suggest).not.toHaveBeenCalled();
  expect(ui.propose).not.toHaveBeenCalled();
  expect(await readFile(f.file, 'utf8')).toBe(original);
  expect((await loadUrs(f.file)).open_questions[0]).not.toHaveProperty('resolution');
});
