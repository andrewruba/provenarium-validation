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
import { sha256 } from '../src/files.js';

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
    select: vi.fn<(...args: unknown[]) => Promise<string | symbol>>().mockResolvedValue('later'),
    log: (value: string) => logs.push(value),
    logs,
    propose: vi.fn(async (urs: Urs, _recommendations?: UrsAnswerSuggestions) => ({
      value: proposal(urs),
      incomplete: false,
      questions: [],
      spend: { cap: 15, actual: 0, reserved: 0, calls: 0 },
    })),
  };
}
const clearAnswer =
  'Require confirmation before clearing; cancellation preserves all saved records.';
function suggestionRuntime(isTTY = true) {
  return {
    ...runtime(isTTY),
    suggest: vi.fn<(urs: Urs, ids: string[]) => Promise<AuthoringResult<UrsAnswerSuggestions>>>(
      async (_urs, ids) => ({
        value: {
          suggestions: ids.map((question_id) => ({
            question_id,
            answer: question_id === 'Q-CSV' ? answer : clearAnswer,
            basis: question_id === 'Q-CSV' ? ('documented' as const) : ('decision' as const),
            explanation:
              question_id === 'Q-CSV'
                ? 'The design specifies a header-only file.'
                : 'Proposed default to make accidental clearing reversible before confirmation.',
            citations: question_id === 'Q-CSV' ? [{ source: 'design', location: 'design.md' }] : [],
            choices: [],
          })),
        },
        incomplete: false,
        questions: [],
        spend: { cap: 15, actual: 0, reserved: 0, calls: 1 },
      }),
    ),
  };
}
async function artifacts(root: string, suffix: string) {
  const directory = join(root, '.provenarium', 'resolutions');
  return (await readdir(directory))
    .filter((name) => name.endsWith(suffix))
    .map((name) => join(directory, name));
}
async function savedProposal(root: string) {
  const files = await artifacts(root, '.proposal.json');
  expect(files).toHaveLength(1);
  return files[0];
}
function partial(urs: Urs): UrsResolutionProposal {
  const value = proposal(urs);
  value.requirements = value.requirements.filter((change) => change.value.id === 'URS-CSV');
  value.unresolved = [
    { question_id: 'Q-CLEAR', reason: 'Supply the externally approved clearing policy.' },
  ];
  return value;
}

it('accepts recommendations and their requirement changes in one review with no questionnaire', async () => {
  const f = await fixture();
  const ui = suggestionRuntime();
  ui.select.mockImplementationOnce(async () => {
    expect(await readFile(f.file, 'utf8')).toBe(f.original);
    return 'accept';
  });
  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);
  expect(ui.suggest).toHaveBeenCalledOnce();
  expect(ui.propose).toHaveBeenCalledOnce();
  expect(ui.select).toHaveBeenCalledOnce();
  expect(ui.text).not.toHaveBeenCalled();
  expect(ui.confirm).not.toHaveBeenCalled();
  expect(ui.suggest.mock.calls[0][1]).toEqual(['Q-CSV', 'Q-CLEAR']);
  expect(ui.logs.join('\n')).toContain('Documented behavior');
  expect(ui.logs.join('\n')).toContain('Proposed default');
  expect(ui.logs.join('\n')).toContain('design.md');
  expect(ui.logs.join('\n')).not.toContain('Related requirement:');
  const saved = await loadUrs(f.file);
  expect(saved.open_questions.map((q) => questionStatus(saved, q))).toEqual([
    'resolved',
    'resolved',
  ]);
  expect(saved.open_questions.map((q) => q.answer)).toEqual([answer, clearAnswer]);
  expect(saved.open_questions[0].resolution?.decision).toEqual({
    authority: 'delegated',
    basis: 'documented',
    rationale: 'The design specifies a header-only file.',
    citations: [{ source: 'design', location: 'design.md' }],
  });
  expect(saved.open_questions[1].resolution?.decision).toMatchObject({
    authority: 'delegated',
    basis: 'decision',
    rationale: 'Proposed default to make accidental clearing reversible before confirmation.',
    citations: [],
  });
  expect(saved.document.revision).not.toBe('1');
  expect(saved.open_questions.map((q) => q.question)).toEqual(
    f.urs.open_questions.map((q) => q.question),
  );
  const artifact = JSON.parse(await readFile(await savedProposal(f.root), 'utf8'));
  expect(artifact.schema_version).toBe(2);
  expect(artifact.answers[1]).toMatchObject({
    question_id: 'Q-CLEAR',
    basis: 'decision',
    answer: clearAnswer,
  });
  expect(ui.logs.at(-1)).toBe('2 resolved, 0 pending.');
  expect(ui.logs.at(-1)).not.toContain('urs check');
});
it.each(['later', Symbol('cancel')])(
  'leaves working YAML byte-exact when review is deferred (%s)',
  async (selection) => {
    const f = await fixture();
    const ui = suggestionRuntime();
    ui.select.mockResolvedValueOnce(selection);
    await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);
    expect(await readFile(f.file, 'utf8')).toBe(f.original);
    expect(ui.logs.join('\n')).toContain('Run validate again to continue.');
    expect(ui.logs.join('\n')).not.toContain('Check requirements:');
    const artifact = JSON.parse(await readFile(await savedProposal(f.root), 'utf8'));
    expect(artifact.answers.map((record: { answer: string }) => record.answer)).toEqual([
      answer,
      clearAnswer,
    ]);
    expect(JSON.stringify(artifact)).not.toContain('"authority"');
    const diff = await readFile((await artifacts(f.root, '.diff.txt'))[0], 'utf8');
    expect(diff).not.toContain('authority: delegated');
  },
);
it('reopens a saved recommendation review on retry without another API request', async () => {
  const f = await fixture();
  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, suggestionRuntime());
  const ui = suggestionRuntime();
  ui.select.mockResolvedValueOnce('accept');
  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);
  expect(ui.suggest).not.toHaveBeenCalled();
  expect(ui.propose).not.toHaveBeenCalled();
  expect(ui.select).toHaveBeenCalledOnce();
  const saved = await loadUrs(f.file);
  expect(saved.open_questions.map((q) => questionStatus(saved, q))).toEqual([
    'resolved',
    'resolved',
  ]);
  expect(saved.open_questions[1].answer).toBe(clearAnswer);
  expect(saved.open_questions.map((q) => q.resolution?.decision?.authority)).toEqual([
    'delegated',
    'delegated',
  ]);
});
it('edits selected recommendations as a batch and regenerates once before acceptance', async () => {
  const f = await fixture();
  const ui = suggestionRuntime();
  ui.select
    .mockResolvedValueOnce('edit')
    .mockResolvedValueOnce('Q-CSV')
    .mockResolvedValueOnce('Q-CLEAR')
    .mockResolvedValueOnce('done')
    .mockResolvedValueOnce('accept');
  ui.text
    .mockResolvedValueOnce('Disable empty export and explain why.')
    .mockResolvedValueOnce('Clear immediately.');
  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);
  expect(ui.propose).toHaveBeenCalledTimes(2);
  expect(ui.text).toHaveBeenCalledTimes(2);
  expect(ui.text.mock.calls[0][0]).toMatchObject({ initialValue: answer });
  expect(ui.text.mock.calls[1][0]).toMatchObject({ initialValue: clearAnswer });
  expect(ui.propose.mock.calls[1][0].open_questions.map((q) => q.answer)).toEqual([
    'Disable empty export and explain why.',
    'Clear immediately.',
  ]);
  expect(ui.propose.mock.calls[1][1]).toEqual({ suggestions: [] });
  expect((await loadUrs(f.file)).open_questions.map((q) => q.answer)).toEqual([
    'Disable empty export and explain why.',
    'Clear immediately.',
  ]);
  expect((await loadUrs(f.file)).open_questions.map((q) => q.resolution?.decision)).toEqual([
    { authority: 'user', basis: 'human', rationale: 'Edited in this review.', citations: [] },
    { authority: 'user', basis: 'human', rationale: 'Edited in this review.', citations: [] },
  ]);
});
it('does not make another proposal request for unchanged edits', async () => {
  const f = await fixture();
  const ui = suggestionRuntime();
  ui.select
    .mockResolvedValueOnce('edit')
    .mockResolvedValueOnce('Q-CSV')
    .mockResolvedValueOnce('done')
    .mockResolvedValueOnce('later');
  ui.text.mockResolvedValueOnce(answer);
  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);
  expect(ui.propose).toHaveBeenCalledOnce();
  expect(await readFile(f.file, 'utf8')).toBe(f.original);
});
it('bounds edited review regeneration to two updates within the command', async () => {
  const f = await fixture();
  const ui = suggestionRuntime();
  for (let n = 0; n < 2; n++)
    ui.select
      .mockResolvedValueOnce('edit')
      .mockResolvedValueOnce('Q-CLEAR')
      .mockResolvedValueOnce('done');
  ui.select.mockImplementationOnce(async (options: any) => {
    expect(options.options.map((x: { value: string }) => x.value)).not.toContain('edit');
    return 'accept';
  });
  ui.text
    .mockResolvedValueOnce('First revised decision.')
    .mockResolvedValueOnce('Second revised decision.');
  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);
  expect(ui.propose).toHaveBeenCalledTimes(3);
  expect((await loadUrs(f.file)).open_questions[1].answer).toBe('Second revised decision.');
});
it('shows complete before/after text only when the reviewer opens full changes', async () => {
  const f = await fixture();
  const ui = suggestionRuntime();
  ui.select
    .mockImplementationOnce(async () => {
      expect(ui.logs.join('\n')).not.toContain('Before:');
      return 'details';
    })
    .mockImplementationOnce(async () => {
      expect(ui.logs.join('\n')).toContain('Before:');
      expect(ui.logs.join('\n')).toContain(decidedStatement);
      expect(ui.logs.join('\n')).toContain('Complete proposed requirements');
      return 'accept';
    });
  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);
  expect(ui.propose).toHaveBeenCalledOnce();
  expect(ui.confirm).not.toHaveBeenCalled();
});
it('preserves concrete saved answers and recommends only for unanswered questions', async () => {
  const f = await fixture(true);
  const ui = suggestionRuntime();
  ui.select.mockResolvedValueOnce('accept');
  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);
  expect(ui.suggest.mock.calls[0][1]).toEqual(['Q-CLEAR']);
  expect(ui.propose.mock.calls[0][0].open_questions[0].answer).toBe(answer);
  expect(ui.logs.join('\n')).toContain('Your saved answer');
  expect((await loadUrs(f.file)).open_questions[0].resolution?.decision).toEqual({
    authority: 'user',
    basis: 'human',
    rationale: 'Your recorded answer.',
    citations: [],
  });
});
it('recognizes delegated judgment and proposes a concrete default instead of keeping the instruction as an answer', async () => {
  const f = await fixture();
  f.urs.open_questions[1].answer = 'choose something reasonable';
  await writeFile(f.file, stringify(f.urs));
  const ui = suggestionRuntime();
  ui.select.mockResolvedValueOnce('accept');
  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);
  expect(ui.suggest.mock.calls[0][1]).toEqual(['Q-CSV', 'Q-CLEAR']);
  expect(ui.propose.mock.calls[0][0].open_questions[1].answer).toBe(clearAnswer);
  expect((await loadUrs(f.file)).open_questions[1].answer).toBe(clearAnswer);
  expect((await loadUrs(f.file)).open_questions[1].resolution?.decision).toMatchObject({
    authority: 'delegated',
    original_answer: 'choose something reasonable',
  });
});
it('shows a genuine missing decision inline while accepting independent ready changes without more questions', async () => {
  const f = await fixture();
  const ui = suggestionRuntime();
  const suggest = ui.suggest.getMockImplementation()!;
  ui.suggest.mockImplementationOnce(async (urs, ids) => {
    const r = await suggest(urs, ids);
    r.value!.suggestions[1].answer = null;
    r.value!.suggestions[1].explanation = 'Supply the externally approved retention policy.';
    return r;
  });
  ui.select.mockResolvedValueOnce('accept');
  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);
  expect(ui.text).not.toHaveBeenCalled();
  expect(ui.select).toHaveBeenCalledOnce();
  expect(ui.propose).toHaveBeenCalledOnce();
  const saved = await loadUrs(f.file);
  expect(questionStatus(saved, saved.open_questions[0])).toBe('resolved');
  expect(questionStatus(saved, saved.open_questions[1])).toBe('unanswered');
  expect(ui.logs.join('\n')).toContain('Needs specific evidence');
  expect(ui.logs.at(-1)).not.toContain('Check requirements:');
});
it('keeps delegated null recommendations pending without passing delegation as a human answer', async () => {
  const f = await fixture();
  f.urs.open_questions[1].answer = 'choose something reasonable';
  const original = stringify(f.urs);
  await writeFile(f.file, original);
  const ui = suggestionRuntime();
  const suggest = ui.suggest.getMockImplementation()!;
  ui.suggest.mockImplementationOnce(async (urs, ids) => {
    const result = await suggest(urs, ids);
    result.value!.suggestions[1].answer = null;
    result.value!.suggestions[1].explanation = 'A specific externally approved limit is required.';
    return result;
  });
  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);
  expect(ui.propose.mock.calls[0][0].open_questions[1].answer).toBeNull();
  expect(pendingAnsweredQuestions(ui.propose.mock.calls[0][0]).map((q) => q.id)).toEqual(['Q-CSV']);
  expect(ui.logs.join('\n')).toContain('1 ready to accept; 1 pending.');
  expect(ui.logs.join('\n')).toContain('Needs specific evidence');
  expect(ui.logs.join('\n')).not.toContain('choose something reasonable');
  const menu = ui.select.mock.calls[0][0] as { options: { value: string; label: string }[] };
  expect(menu.options.find((item) => item.value === 'accept')!.label).toBe(
    'Accept ready recommendations and changes',
  );
  const apply = (await readdir(join(f.root, '.provenarium', 'resolutions'))).find((name) =>
    name.startsWith('pending-'),
  )!;
  const pending = join(f.root, '.provenarium', 'resolutions', apply);
  const artifact = JSON.parse(await readFile(pending, 'utf8'));
  expect(artifact.deferred_question_ids).toEqual(['Q-CLEAR']);
  const continuation = runtime();
  continuation.select.mockResolvedValueOnce('accept');
  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, continuation);
  expect(continuation.propose).not.toHaveBeenCalled();
  const saved = await loadUrs(f.file);
  expect(saved.open_questions[1]).toEqual(f.urs.open_questions[1]);
  expect(questionStatus(saved, saved.open_questions[0])).toBe('resolved');
  const resumed = suggestionRuntime();
  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, resumed);
  expect(resumed.suggest).not.toHaveBeenCalled();
  expect(resumed.propose).not.toHaveBeenCalled();
  expect(resumed.logs.join('\n')).toContain('Needs specific evidence');
  expect(resumed.logs.join('\n')).not.toContain('choose something reasonable');
});

it('retains unresolved concrete answers after accepting a partial proposal without launching a clarification questionnaire', async () => {
  const f = await fixture(true);
  f.urs.open_questions[1].answer = 'Apply the approved policy.';
  await writeFile(f.file, stringify(f.urs));
  const ui = suggestionRuntime();
  ui.propose.mockImplementationOnce(async (urs) => ({
    value: partial(urs),
    incomplete: false,
    questions: [],
    spend: { cap: 15, actual: 0, reserved: 0, calls: 1 },
  }));
  ui.select.mockResolvedValueOnce('accept');
  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);
  expect(ui.suggest).not.toHaveBeenCalled();
  expect(ui.text).not.toHaveBeenCalled();
  expect(ui.propose).toHaveBeenCalledOnce();
  const saved = await loadUrs(f.file);
  expect(saved.open_questions.map((q) => questionStatus(saved, q))).toEqual([
    'resolved',
    'answered',
  ]);
  expect(saved.open_questions[1]).toEqual(f.urs.open_questions[1]);
});
it('accepts only ready answers when an AI recommendation remains unresolved in the proposal', async () => {
  const f = await fixture();
  const ui = suggestionRuntime();
  ui.propose.mockImplementationOnce(async (urs) => ({
    value: partial(urs),
    incomplete: false,
    questions: [],
    spend: { cap: 15, actual: 0, reserved: 0, calls: 1 },
  }));
  ui.select.mockResolvedValueOnce('accept');
  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);
  const saved = await loadUrs(f.file);
  expect(questionStatus(saved, saved.open_questions[0])).toBe('resolved');
  expect(saved.open_questions[1]).toEqual(f.urs.open_questions[1]);
  const artifact = JSON.parse(await readFile(await savedProposal(f.root), 'utf8'));
  expect(artifact.answers[1].answer).toBe(clearAnswer);
});
it('resumes pending human edits after partial acceptance against the new revision without rewriting resolved answers', async () => {
  const f = await fixture();
  const ui = suggestionRuntime();
  ui.propose.mockImplementation(async (urs) => ({
    value: partial(urs),
    incomplete: false,
    questions: [],
    spend: { cap: 15, actual: 0, reserved: 0, calls: 1 },
  }));
  ui.select
    .mockResolvedValueOnce('edit')
    .mockResolvedValueOnce('Q-CLEAR')
    .mockResolvedValueOnce('done')
    .mockResolvedValueOnce('accept');
  ui.text.mockResolvedValueOnce('Require confirmation with an explicit Cancel button.');
  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);
  const firstAccepted = await loadUrs(f.file);
  expect(firstAccepted.open_questions[0].resolution?.decision?.authority).toBe('delegated');
  const resume = (await artifacts(f.root, '.recommendations.json'))[0];
  const retained = JSON.parse(await readFile(resume, 'utf8'));
  expect(retained.source_sha256).toBe(sha256(await readFile(f.file, 'utf8')));
  expect(retained.source_sha256).not.toBe(sha256(f.original));
  expect(retained.answers).toEqual([
    expect.objectContaining({
      question_id: 'Q-CLEAR',
      answer: 'Require confirmation with an explicit Cancel button.',
      basis: 'human',
    }),
  ]);
  expect(
    retained.recommendations.suggestions.map((item: { question_id: string }) => item.question_id),
  ).toEqual(['Q-CLEAR']);
  expect(firstAccepted.open_questions[1]).toEqual(f.urs.open_questions[1]);
  const resumed = suggestionRuntime();
  resumed.select.mockResolvedValueOnce('accept');
  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, resumed);
  expect(resumed.suggest).not.toHaveBeenCalled();
  expect(resumed.propose).toHaveBeenCalledOnce();
  const staged = resumed.propose.mock.calls[0][0];
  expect(staged.families).toEqual(firstAccepted.families);
  expect(staged.open_questions[0]).toEqual(firstAccepted.open_questions[0]);
  expect(pendingAnsweredQuestions(staged).map((q) => q.id)).toEqual(['Q-CLEAR']);
  expect(resumed.propose.mock.calls[0][1]).toEqual({ suggestions: [] });
  const complete = await loadUrs(f.file);
  expect(complete.open_questions[0]).toEqual(firstAccepted.open_questions[0]);
  expect(complete.open_questions[1].answer).toBe(
    'Require confirmation with an explicit Cancel button.',
  );
  expect(complete.open_questions[1].resolution?.decision).toEqual({
    authority: 'user',
    basis: 'human',
    rationale: 'Edited in this review.',
    citations: [],
  });
  expect(complete.open_questions.map((q) => questionStatus(complete, q))).toEqual([
    'resolved',
    'resolved',
  ]);
});

it('does not ask blank-page questions or spend on a proposal when every recommendation needs evidence', async () => {
  const f = await fixture();
  const ui = suggestionRuntime();
  const suggest = ui.suggest.getMockImplementation()!;
  ui.suggest.mockImplementationOnce(async (urs, ids) => {
    const r = await suggest(urs, ids);
    for (const s of r.value!.suggestions) {
      s.answer = null;
      s.explanation = 'A specific external value is missing.';
    }
    return r;
  });
  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);
  expect(ui.propose).not.toHaveBeenCalled();
  expect(ui.text).not.toHaveBeenCalled();
  expect(
    (ui.select.mock.calls[0][0] as any).options.map((x: { value: string }) => x.value),
  ).not.toContain('accept');
  expect(await readFile(f.file, 'utf8')).toBe(f.original);
});
it('stops after failed recommendations with saved answers unchanged instead of falling back to a questionnaire', async () => {
  const f = await fixture();
  const ui = suggestionRuntime();
  ui.suggest.mockResolvedValueOnce({
    incomplete: true,
    questions: ['Provider unavailable.'],
    spend: { cap: 15, actual: 0, reserved: 1, calls: 1 },
  });
  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);
  expect(ui.text).not.toHaveBeenCalled();
  expect(ui.select).not.toHaveBeenCalled();
  expect(ui.propose).not.toHaveBeenCalled();
  expect(await readFile(f.file, 'utf8')).toBe(f.original);
  expect(ui.logs.join('\n')).toContain('Recommendations could not be prepared');
});
it('retains unapproved recommendations when proposal generation fails without changing the working URS', async () => {
  const f = await fixture();
  const ui = suggestionRuntime();
  ui.propose.mockResolvedValueOnce({
    value: undefined as unknown as UrsResolutionProposal,
    incomplete: true,
    questions: ['Budget exceeded.'],
    spend: { cap: 15, actual: 0, reserved: 1, calls: 1 },
  });
  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);
  expect(await readFile(f.file, 'utf8')).toBe(f.original);
  expect(ui.select).not.toHaveBeenCalled();
  const retained = JSON.parse(
    await readFile((await artifacts(f.root, '.recommendations.json'))[0], 'utf8'),
  );
  expect(retained.answers[0].answer).toBe(answer);
});
it('retains edited draft answers if regeneration fails and never applies the stale proposal', async () => {
  const f = await fixture();
  const ui = suggestionRuntime();
  ui.select
    .mockResolvedValueOnce('edit')
    .mockResolvedValueOnce('Q-CLEAR')
    .mockResolvedValueOnce('done');
  ui.text.mockResolvedValueOnce('A new clearing decision.');
  ui.propose
    .mockImplementationOnce(async (urs) => ({
      value: proposal(urs),
      incomplete: false,
      questions: [],
      spend: { cap: 15, actual: 0, reserved: 0, calls: 1 },
    }))
    .mockResolvedValueOnce({
      value: undefined as unknown as UrsResolutionProposal,
      incomplete: true,
      questions: ['Budget exceeded.'],
      spend: { cap: 15, actual: 0, reserved: 1, calls: 2 },
    });
  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);
  expect(await readFile(f.file, 'utf8')).toBe(f.original);
  const resume = (await artifacts(f.root, '.recommendations.json'))[0];
  const retained = JSON.parse(await readFile(resume, 'utf8'));
  expect(retained.answers[1]).toMatchObject({ answer: 'A new clearing decision.', basis: 'human' });
  const resumed = suggestionRuntime();
  resumed.select.mockResolvedValueOnce('accept');
  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, resumed);
  expect(resumed.suggest).not.toHaveBeenCalled();
  expect(resumed.propose).toHaveBeenCalledOnce();
  expect(resumed.propose.mock.calls[0][0].open_questions[1].answer).toBe(
    'A new clearing decision.',
  );
  expect(resumed.propose.mock.calls[0][1]!.suggestions.map((q) => q.question_id)).toEqual([
    'Q-CSV',
  ]);
  const saved = await loadUrs(f.file);
  expect(saved.open_questions[1].answer).toBe('A new clearing decision.');
  expect(questionStatus(saved, saved.open_questions[1])).toBe('resolved');
});
it('retains edited draft answers when editing is cancelled', async () => {
  const f = await fixture();
  const ui = suggestionRuntime();
  ui.select
    .mockResolvedValueOnce('edit')
    .mockResolvedValueOnce('Q-CLEAR')
    .mockResolvedValueOnce(Symbol('cancel'));
  ui.text.mockResolvedValueOnce('My pending edit.');
  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);
  expect(await readFile(f.file, 'utf8')).toBe(f.original);
  expect(ui.propose).toHaveBeenCalledOnce();
  const retained = JSON.parse(
    await readFile((await artifacts(f.root, '.recommendations.json'))[0], 'utf8'),
  );
  expect(retained.answers[1].answer).toBe('My pending edit.');
});
it('refreshes a saved review when the working requirements change', async () => {
  const f = await fixture();
  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, suggestionRuntime());
  const edited = f.original + '\n# A later human edit\n';
  await writeFile(f.file, edited);
  const resumed = suggestionRuntime();
  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, resumed);
  expect(resumed.suggest).toHaveBeenCalledOnce();
  expect(resumed.propose).toHaveBeenCalledOnce();
  expect(await readFile(f.file, 'utf8')).toBe(edited);
});
it('preserves concurrent edits made during suggestion generation', async () => {
  const f = await fixture();
  const ui = suggestionRuntime();
  const suggest = ui.suggest.getMockImplementation()!;
  const changed = f.original + '\n# Concurrent edit\n';
  ui.suggest.mockImplementationOnce(async (urs, ids) => {
    await writeFile(f.file, changed);
    return suggest(urs, ids);
  });
  await expect(resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui)).rejects.toThrow(
    /changed during review/,
  );
  expect(ui.propose).not.toHaveBeenCalled();
  expect(await readFile(f.file, 'utf8')).toBe(changed);
});
it('rechecks the source after acceptance so concurrent edits survive', async () => {
  const f = await fixture();
  const ui = suggestionRuntime();
  const changed = f.original + '\n# Changed during review\n';
  ui.select.mockImplementationOnce(async () => {
    await writeFile(f.file, changed);
    return 'accept';
  });
  await expect(resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui)).rejects.toThrow(
    /changed during review/,
  );
  expect(await readFile(f.file, 'utf8')).toBe(changed);
});
it('rejects invented requirement IDs without changing saved answers', async () => {
  const f = await fixture(true);
  const ui = runtime(false);
  ui.propose.mockImplementationOnce(async (urs) => {
    const value = proposal(urs);
    value.requirements[0].value.id = 'URS-INVENTED';
    return {
      value,
      incomplete: false,
      questions: [],
      spend: { cap: 15, actual: 0, reserved: 0, calls: 1 },
    };
  });
  await expect(resolveUrsFile({ root: f.root, file: 'urs.yaml', yes: true }, ui)).rejects.toThrow(
    /does not exist|unknown/,
  );
  expect(await readFile(f.file, 'utf8')).toBe(f.original);
});
it('skips already resolved questions without another request', async () => {
  const f = await fixture(true);
  f.urs.open_questions = [f.urs.open_questions[0]];
  const resolved = applyResolutionProposal(f.urs, proposal(f.urs));
  await writeFile(f.file, stringify(resolved));
  const ui = suggestionRuntime();
  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui);
  expect(ui.suggest).not.toHaveBeenCalled();
  expect(ui.propose).not.toHaveBeenCalled();
  expect(ui.select).not.toHaveBeenCalled();
  expect((await loadUrs(f.file)).open_questions).toEqual(resolved.open_questions);
});
it.each(['packages/pkg-1/urs.yaml', 'candidates/candidate-1/urs.yaml', '.provenarium/urs.yaml'])(
  'refuses immutable/internal target %s',
  async (file) => {
    const f = await fixture(true);
    const target = join(f.root, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, f.original);
    const ui = suggestionRuntime();
    await expect(resolveUrsFile({ root: f.root, file }, ui)).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe(f.original);
    expect(ui.suggest).not.toHaveBeenCalled();
  },
);
it.each(['approval.json', 'candidate.json'])(
  'refuses package roots marked by %s',
  async (marker) => {
    const f = await fixture(true);
    await writeFile(join(f.root, marker), '{}');
    const ui = runtime();
    await expect(resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui)).rejects.toThrow();
    expect(await readFile(f.file, 'utf8')).toBe(f.original);
  },
);
it.each([false, true])(
  'refuses projects nested in approved packages, including symlinks (%s)',
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
    await expect(resolveUrsFile({ root: project, file: 'urs.yaml' }, runtime())).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe(f.original);
  },
);
it('rejects malformed working requirements before any provider request', async () => {
  const f = await fixture();
  f.urs.families[0].requirements[0].references = ['OQ-MISSING'];
  const original = stringify(f.urs);
  await writeFile(f.file, original);
  const ui = suggestionRuntime();
  await expect(resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui)).rejects.toThrow(
    /Update the working requirements/,
  );
  expect(ui.suggest).not.toHaveBeenCalled();
  expect(ui.propose).not.toHaveBeenCalled();
  expect(await readFile(f.file, 'utf8')).toBe(original);
});
it('does not apply a saved review that introduces an invalid normative reference', async () => {
  const f = await fixture();
  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, suggestionRuntime());
  const apply = (await readdir(join(f.root, '.provenarium', 'resolutions'))).find((name) =>
    name.startsWith('pending-'),
  )!;
  const pending = join(f.root, '.provenarium', 'resolutions', apply);
  const artifact = JSON.parse(await readFile(pending, 'utf8'));
  artifact.proposal.requirements[0].value.references = ['../outside-project.csv'];
  await writeFile(pending, JSON.stringify(artifact));
  const ui = suggestionRuntime(false);
  await expect(resolveUrsFile({ root: f.root, file: 'urs.yaml' }, ui)).rejects.toThrow(
    /outside-project/,
  );
  expect(ui.suggest).not.toHaveBeenCalled();
  expect(ui.propose).not.toHaveBeenCalled();
  expect(await readFile(f.file, 'utf8')).toBe(f.original);
});
it('validates saved staged answer IDs instead of mutating arbitrary question records', async () => {
  const f = await fixture();
  await resolveUrsFile({ root: f.root, file: 'urs.yaml' }, suggestionRuntime());
  const apply = (await readdir(join(f.root, '.provenarium', 'resolutions'))).find((name) =>
    name.startsWith('pending-'),
  )!;
  const pending = join(f.root, '.provenarium', 'resolutions', apply);
  const artifact = JSON.parse(await readFile(pending, 'utf8'));
  artifact.answers[0].question_id = 'UNKNOWN';
  await writeFile(pending, JSON.stringify(artifact));
  await expect(resolveUrsFile({ root: f.root, file: 'urs.yaml' }, runtime(false))).rejects.toThrow(
    /unknown question/,
  );
  expect(await readFile(f.file, 'utf8')).toBe(f.original);
});
