import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import { ursSchema, type Urs } from '../src/schema.js';
import { loadUrs, pendingAnsweredQuestions, questionStatus } from '../src/urs.js';
import { applyResolutionProposal, type UrsResolutionProposal } from '../src/urs-resolution.js';
import { resolveUrsFile } from '../src/urs-resolve-cli.js';

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
