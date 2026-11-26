import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { loadProject, saveProject } from '../src/project.js';
import { loadUrs, templateText } from '../src/urs.js';
import { ursSchema } from '../src/schema.js';

const mocks = vi.hoisted(() => ({
  draftUrs: vi.fn(),
  suggestUrsAnswers: vi.fn(),
  proposeUrsResolution: vi.fn(),
  getProviderKey: vi.fn(),
  renderUrs: vi.fn(),
  discoveryOptions: vi.fn(),
  openDiscovery: vi.fn(),
  closeDiscovery: vi.fn(),
  text: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('@clack/prompts', () => ({
  text: mocks.text,
  select: mocks.select,
  confirm: mocks.confirm,
  isCancel: (value: unknown) => typeof value === 'symbol',
}));
vi.mock('../src/credentials.js', () => ({
  getProviderKey: mocks.getProviderKey,
  forgetProviderKey: vi.fn(),
  prepareBindings: vi.fn(() => {
    throw new Error('Unexpected application credential request');
  }),
}));
vi.mock('../src/authoring/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/authoring/index.js')>()),
  draftUrs: mocks.draftUrs,
  suggestUrsAnswers: mocks.suggestUrsAnswers,
  proposeUrsResolution: mocks.proposeUrsResolution,
}));
vi.mock('../src/reports.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/reports.js')>()),
  renderUrs: mocks.renderUrs,
}));
vi.mock('../src/authoring/discovery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/authoring/discovery.js')>()),
  Discovery: class {
    constructor(options: unknown) {
      mocks.discoveryOptions(options);
    }
    open = mocks.openDiscovery;
    close = mocks.closeDiscovery;
  },
}));

const draft = ursSchema.parse({
  schema_version: 1,
  document: {
    id: 'URS-DILUTION',
    revision: '1',
    title: 'Dilution calculator',
    intended_use: 'Calculate dilution preparations for scientists.',
  },
  families: [
    {
      id: 'results',
      title: 'Calculation results',
      requirements: [
        {
          id: 'URS-RESULT-001',
          title: 'Export results',
          statement: 'Scientists shall be able to export the displayed preparation as CSV.',
        },
      ],
    },
  ],
  open_questions: [],
});
const directories: string[] = [];
let originalArgv: string[];
let originalExitCode: typeof process.exitCode;
let originalIsTTY: PropertyDescriptor | undefined;
let originalSigintListeners: Set<(...args: unknown[]) => void>;

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  originalArgv = process.argv;
  originalExitCode = process.exitCode;
  originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  originalSigintListeners = new Set(process.listeners('SIGINT'));
  process.exitCode = undefined;
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.getProviderKey.mockResolvedValue('test-provider-key');
  mocks.openDiscovery.mockImplementation(() => {
    throw new Error('Unexpected browser observation');
  });
  mocks.closeDiscovery.mockResolvedValue(undefined);
  mocks.suggestUrsAnswers.mockImplementation(() => {
    throw new Error('Unexpected answer suggestion request');
  });
  mocks.proposeUrsResolution.mockImplementation(() => {
    throw new Error('Unexpected resolution authoring request');
  });
  mocks.draftUrs.mockResolvedValue({
    value: draft,
    incomplete: false,
    questions: [],
    spend: { cap: 15, actual: 0, reserved: 0, calls: 0 },
    reviewRounds: 0,
  });
});

afterEach(async () => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  if (originalIsTTY) Object.defineProperty(process.stdin, 'isTTY', originalIsTTY);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
  for (const listener of process.listeners('SIGINT'))
    if (!originalSigintListeners.has(listener)) process.removeListener('SIGINT', listener);
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'provenarium URS CLI '));
  directories.push(root);
  await writeFile(join(root, 'design.md'), 'Dilution results are displayed and exported as CSV.');
  return root;
}

async function runCli(root: string, args: string[]) {
  process.argv = [process.execPath, 'provenarium', '--project', root, ...args];
  await import('../src/cli.js');
  expect(console.error).not.toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();
}

it('dispatches context and URL flags to drafting without any interview or brief', async () => {
  const root = await fixture();
  const url = 'https://example.com/dilution';
  await runCli(root, [
    'urs',
    'generate',
    '--context',
    'design.md',
    '--url',
    url,
    '--provider',
    'openai',
    '--yes',
    '--no-pdf',
  ]);

  expect(mocks.text).not.toHaveBeenCalled();
  expect(mocks.select).not.toHaveBeenCalled();
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(mocks.getProviderKey).toHaveBeenCalledExactlyOnceWith('openai');
  expect(mocks.draftUrs).toHaveBeenCalledOnce();
  expect(mocks.draftUrs.mock.calls[0][0]).toMatchObject({
    root,
    brief: undefined,
    url,
    thoroughness: 'standard',
    maxSpend: 15,
    sources: [{ id: 'source-1', path: 'design.md' }],
  });
  expect(await loadUrs(join(root, 'urs.yaml'))).toEqual(draft);
  expect(mocks.renderUrs).toHaveBeenCalledExactlyOnceWith(draft, join(root, 'urs'), false);
  expect(await loadProject(root)).toMatchObject({
    target_url: url,
    provider: 'openai',
    context: [{ id: 'source-1', path: 'design.md' }],
  });
});

it('bare urs collects only context and URL, then preserves an existing template automatically', async () => {
  const root = await fixture();
  const url = 'https://example.com/deployed-dilution';
  await writeFile(join(root, 'urs.yaml'), templateText);
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  mocks.text
    .mockResolvedValueOnce('design.md')
    .mockResolvedValueOnce('')
    .mockResolvedValueOnce(url);
  mocks.select.mockResolvedValueOnce('openai').mockResolvedValueOnce('thorough');
  mocks.confirm.mockResolvedValueOnce(true);

  await runCli(root, ['urs']);

  expect(mocks.text).toHaveBeenCalledTimes(3);
  expect(mocks.text.mock.calls.map(([options]) => options.message)).toEqual([
    expect.stringMatching(/Application source or document/),
    expect.stringMatching(/Add more context/),
    'Deployed application URL',
  ]);
  expect(mocks.select).toHaveBeenCalledTimes(2);
  expect(mocks.select.mock.calls[0][0].message).toBe('Authoring provider');
  expect(mocks.select.mock.calls[1][0]).toMatchObject({
    message: 'Authoring thoroughness',
    initialValue: 'standard',
  });
  const levels = mocks.select.mock.calls[1][0].options;
  expect(levels.map((option: { value: string }) => option.value)).toEqual([
    'quick',
    'standard',
    'thorough',
  ]);
  for (const [index, cap] of [5, 15, 40].entries())
    expect(levels[index].label).toContain(`$${cap.toFixed(2)} max per command`);
  expect(mocks.confirm).toHaveBeenCalledOnce();
  expect(mocks.confirm.mock.calls[0][0].message).toMatch(/provider.*spending ceiling/);
  expect(mocks.text.mock.invocationCallOrder.at(-1)).toBeLessThan(
    mocks.select.mock.invocationCallOrder[1],
  );
  expect(mocks.select.mock.invocationCallOrder[1]).toBeLessThan(
    mocks.confirm.mock.invocationCallOrder[0],
  );
  expect(mocks.confirm.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.getProviderKey.mock.invocationCallOrder[0],
  );
  expect(mocks.getProviderKey.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.draftUrs.mock.invocationCallOrder[0],
  );
  expect(mocks.draftUrs.mock.calls[0][0]).toMatchObject({
    brief: undefined,
    url,
    thoroughness: 'thorough',
    maxSpend: 40,
    sources: [{ id: 'source-1', path: 'design.md' }],
  });
  expect(await readFile(join(root, 'urs.yaml'), 'utf8')).toBe(templateText);
  const revisions = (await readdir(root)).filter((name) => /^urs\.revision-.+\.yaml$/.test(name));
  expect(revisions).toHaveLength(1);
  expect(await loadUrs(join(root, revisions[0]))).toEqual(draft);
  expect(await loadProject(root)).toMatchObject({
    target_url: url,
    provider: 'openai',
    thoroughness: 'thorough',
    context: [{ id: 'source-1', path: 'design.md' }],
  });
});

it.each([undefined, 7])(
  'preselects the saved level and honors a custom ceiling of %s in the chooser',
  async (ceiling) => {
    const root = await fixture();
    const project = await loadProject(root);
    project.provider = 'openai';
    project.thoroughness = 'quick';
    await saveProject(root, project);
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    mocks.select.mockResolvedValueOnce('standard');
    mocks.confirm.mockResolvedValueOnce(true);

    await runCli(root, [
      'urs',
      'generate',
      '--context',
      'design.md',
      '--no-pdf',
      ...(ceiling ? ['--max-spend', String(ceiling)] : []),
    ]);

    expect(mocks.select).toHaveBeenCalledOnce();
    expect(mocks.select.mock.calls[0][0]).toMatchObject({
      message: 'Authoring thoroughness',
      initialValue: 'quick',
    });
    if (ceiling)
      for (const option of mocks.select.mock.calls[0][0].options)
        expect(option.label).toContain(`$${ceiling.toFixed(2)} max per command`);
    expect(mocks.draftUrs.mock.calls[0][0]).toMatchObject({
      thoroughness: 'standard',
      maxSpend: ceiling ?? 15,
    });
    expect((await loadProject(root)).thoroughness).toBe('standard');
  },
);

it('honors an explicit level and custom ceiling without asking for the level again', async () => {
  const root = await fixture();
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  mocks.confirm.mockResolvedValueOnce(true);

  await runCli(root, [
    'urs',
    'generate',
    '--context',
    'design.md',
    '--provider',
    'openai',
    '--thoroughness',
    'quick',
    '--max-spend',
    '2',
    '--no-pdf',
  ]);

  expect(mocks.select).not.toHaveBeenCalled();
  expect(mocks.confirm).toHaveBeenCalledOnce();
  expect(mocks.draftUrs.mock.calls[0][0]).toMatchObject({ thoroughness: 'quick', maxSpend: 2 });
  expect((await loadProject(root)).thoroughness).toBe('quick');
});

it('uses the saved level without adding prompts to an unattended command', async () => {
  const root = await fixture();
  const project = await loadProject(root);
  project.provider = 'openai';
  project.thoroughness = 'thorough';
  await saveProject(root, project);

  await runCli(root, ['urs', 'generate', '--context', 'design.md', '--yes', '--no-pdf']);

  expect(mocks.text).not.toHaveBeenCalled();
  expect(mocks.select).not.toHaveBeenCalled();
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(mocks.draftUrs.mock.calls[0][0]).toMatchObject({ thoroughness: 'thorough', maxSpend: 40 });
  expect((await loadProject(root)).thoroughness).toBe('thorough');
});

async function resolutionFixture(answer: string | null) {
  const root = await fixture();
  const document = structuredClone(draft);
  document.open_questions = [
    {
      id: 'Q-CSV',
      requirement: 'URS-RESULT-001',
      question: 'Should exporting an empty register produce a header-only CSV?',
      answer,
    },
  ];
  await writeFile(join(root, 'urs.yaml'), stringify(document));
  return { root, document };
}

it('explains saved answers awaiting review and prints the actual resolve command without changing the URS', async () => {
  const root = await fixture();
  const document = structuredClone(draft);
  document.open_questions = [
    {
      id: 'Q-CSV',
      requirement: 'URS-RESULT-001',
      question: 'What should an empty export contain?',
      answer: 'Download column headings without data rows.',
    },
    {
      id: 'Q-ORDER',
      requirement: 'URS-RESULT-001',
      question: 'In what order should records appear in the export?',
      answer: 'Use the displayed register order.',
    },
  ];
  const file = join(root, 'requirements.yaml');
  const original = `# Human answers are retained.\n${stringify(document)}`;
  await writeFile(file, original);
  process.argv = [
    process.execPath,
    'provenarium',
    '--project',
    root,
    'urs',
    'check',
    'requirements.yaml',
  ];

  await import('../src/cli.js');

  expect(process.exitCode).toBe(1);
  expect(console.error).not.toHaveBeenCalled();
  const output = vi.mocked(console.log).mock.calls.flat().join('\n');
  expect(output).toContain(
    '2 answers are saved. Their requirement changes still need review; check does not apply changes.',
  );
  const resume = vi
    .mocked(console.log)
    .mock.calls.flat()
    .find((line) => String(line).startsWith('Resume requirement review:'));
  expect(resume).toBe(
    `Resume requirement review: provenarium --project '${root}' urs resolve requirements.yaml`,
  );
  expect(String(resume)).not.toContain('<file>');
  expect(output).toContain('Q-CSV: answer recorded');
  expect(output).toContain('Q-ORDER: answer recorded');
  expect(output.indexOf('Resume requirement review:')).toBeLessThan(output.indexOf('- Q-CSV:'));
  expect(mocks.draftUrs).not.toHaveBeenCalled();
  expect(mocks.suggestUrsAnswers).not.toHaveBeenCalled();
  expect(mocks.proposeUrsResolution).not.toHaveBeenCalled();
  expect(mocks.getProviderKey).not.toHaveBeenCalled();
  expect(mocks.openDiscovery).not.toHaveBeenCalled();
  expect(await readFile(file, 'utf8')).toBe(original);
  expect((await readdir(root)).sort()).toEqual(['design.md', 'requirements.yaml']);
});

it('dispatches answers-only resolution without authoring or credential access', async () => {
  const { root, document } = await resolutionFixture(null);
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  mocks.text.mockResolvedValueOnce('Yes, download column headings with no data rows.');

  await runCli(root, ['urs', 'resolve', 'urs.yaml', '--answers-only']);

  expect(mocks.text).toHaveBeenCalledOnce();
  expect(mocks.proposeUrsResolution).not.toHaveBeenCalled();
  expect(mocks.suggestUrsAnswers).not.toHaveBeenCalled();
  expect(mocks.getProviderKey).not.toHaveBeenCalled();
  expect(mocks.select).not.toHaveBeenCalled();
  expect(mocks.confirm).not.toHaveBeenCalled();
  const saved = await loadUrs(join(root, 'urs.yaml'));
  expect(saved.families).toEqual(document.families);
  expect(saved.open_questions[0]).toMatchObject({
    id: 'Q-CSV',
    question: document.open_questions[0].question,
    answer: 'Yes, download column headings with no data rows.',
  });
  expect(saved.open_questions[0]).not.toHaveProperty('resolution');
});

it('stages manual answers for review and applies the saved proposal offline on a later invocation', async () => {
  const { root, document } = await resolutionFixture('Download a header-only CSV.');
  const updated = structuredClone(document.families[0].requirements[0]);
  updated.details = ['An empty register shall export the column headings and no data rows.'];
  mocks.proposeUrsResolution.mockResolvedValueOnce({
    value: {
      requirements: [
        {
          question_ids: ['Q-CSV'],
          value: updated,
          reason: 'Specify the empty-export behavior selected by the reviewer.',
        },
      ],
      unresolved: [],
    },
    incomplete: false,
    questions: [],
    spend: { cap: 5, actual: 0, reserved: 0, calls: 1 },
    reviewRounds: 0,
  });

  await runCli(root, [
    'urs',
    'resolve',
    'urs.yaml',
    '--provider',
    'openai',
    '--max-spend',
    '5',
    '--yes',
  ]);

  expect(mocks.proposeUrsResolution).toHaveBeenCalledOnce();
  expect(mocks.suggestUrsAnswers).not.toHaveBeenCalled();
  expect(mocks.proposeUrsResolution.mock.calls[0][0]).toMatchObject({
    urs: document,
    provider: 'openai',
    maxSpend: 5,
  });
  expect(await loadUrs(join(root, 'urs.yaml'))).toEqual(document);
  const reviewFiles = await readdir(join(root, '.provenarium', 'resolutions'));
  const proposalName = reviewFiles.find((name) => name.endsWith('.proposal.json'));
  const diffName = reviewFiles.find((name) => name.endsWith('.diff.txt'));
  expect(proposalName).toBeDefined();
  expect(diffName).toBeDefined();
  const diff = await readFile(join(root, '.provenarium', 'resolutions', diffName!), 'utf8');
  expect(diff).toContain('Before:');
  expect(diff).toContain('After:');
  expect(diff).toContain(updated.details[0]);
  expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain(
    'Proposed requirement changes',
  );

  vi.resetModules();
  mocks.proposeUrsResolution.mockClear();
  mocks.getProviderKey.mockClear();
  await runCli(root, [
    'urs',
    'resolve',
    'urs.yaml',
    '--apply',
    `.provenarium/resolutions/${proposalName}`,
    '--yes',
  ]);

  expect(mocks.proposeUrsResolution).not.toHaveBeenCalled();
  expect(mocks.suggestUrsAnswers).not.toHaveBeenCalled();
  expect(mocks.getProviderKey).not.toHaveBeenCalled();
  expect(mocks.confirm).not.toHaveBeenCalled();
  const applied = await loadUrs(join(root, 'urs.yaml'));
  expect(applied.document.revision).toBe('2');
  expect(applied.families[0].requirements[0]).toEqual(updated);
  expect(applied.open_questions[0]).toMatchObject({
    ...document.open_questions[0],
    resolution: { targets: ['requirement:URS-RESULT-001'] },
  });
});

it('rejects authoring flags on offline saved-proposal application before accessing credentials', async () => {
  const { root } = await resolutionFixture('Download a header-only CSV.');
  process.argv = [
    process.execPath,
    'provenarium',
    '--project',
    root,
    'urs',
    'resolve',
    'urs.yaml',
    '--apply',
    'unread-proposal.json',
    '--provider',
    'openai',
    '--yes',
  ];
  await import('../src/cli.js');

  expect(process.exitCode).toBe(1);
  expect(console.error).toHaveBeenCalledExactlyOnceWith(
    'Error: --answers-only and --apply are offline and do not accept authoring options.',
  );
  expect(mocks.proposeUrsResolution).not.toHaveBeenCalled();
  expect(mocks.getProviderKey).not.toHaveBeenCalled();
});

it('previews once, suggests from linked context, and shares one spending cap with the requirement proposal', async () => {
  const { root } = await resolutionFixture(null);
  const project = await loadProject(root);
  project.target_url = 'https://example.com/deployed-dilution';
  project.context = [{ id: 'design', path: 'design.md' }];
  await saveProject(root, project);
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  mocks.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  mocks.select.mockResolvedValueOnce('accept');
  mocks.suggestUrsAnswers.mockImplementationOnce(async (options) => {
    const reservation = options.budget.reserve(0.5);
    options.budget.settle(reservation, 0.25);
    return {
      value: {
        suggestions: [
          {
            question_id: 'Q-CSV',
            answer: 'Download a header-only CSV.',
            basis: 'documented',
            explanation: 'The design specifies the empty-export behavior.',
            citations: [{ source: 'design', location: 'design.md' }],
            choices: [],
          },
        ],
      },
      incomplete: false,
      questions: [],
      spend: options.budget.snapshot(),
      reviewRounds: 0,
    };
  });
  mocks.proposeUrsResolution.mockImplementationOnce(async (options) => {
    expect(options.budget.snapshot()).toMatchObject({ actual: 0.25, calls: 1, cap: 5 });
    const reservation = options.budget.reserve(0.5);
    options.budget.settle(reservation, 0.3);
    return {
      value: {
        requirements: [
          {
            question_ids: ['Q-CSV'],
            value: {
              ...options.urs.families[0].requirements[0],
              details: ['An empty register shall download a header-only CSV.'],
            },
            reason: 'Apply the accepted empty-export behavior.',
          },
        ],
        unresolved: [],
      },
      incomplete: false,
      questions: [],
      spend: options.budget.snapshot(),
      reviewRounds: 0,
    };
  });

  await runCli(root, ['urs', 'resolve', 'urs.yaml', '--provider', 'openai', '--max-spend', '5']);

  expect(mocks.suggestUrsAnswers).toHaveBeenCalledOnce();
  const suggestions = mocks.suggestUrsAnswers.mock.calls[0][0];
  expect(suggestions).toMatchObject({
    root,
    questionIds: ['Q-CSV'],
    sources: [{ id: 'design', path: 'design.md' }],
    url: project.target_url,
    maxSpend: 5,
  });
  expect(mocks.proposeUrsResolution).toHaveBeenCalledOnce();
  const proposal = mocks.proposeUrsResolution.mock.calls[0][0];
  expect(proposal.budget).toBe(suggestions.budget);
  expect(proposal.budget.snapshot()).toMatchObject({ actual: 0.55, calls: 2, cap: 5 });
  expect(proposal.urs.open_questions[0].answer).toBe('Download a header-only CSV.');
  expect(mocks.getProviderKey).toHaveBeenCalledExactlyOnceWith('openai');
  expect(mocks.confirm).toHaveBeenCalledTimes(2);
  expect(mocks.confirm.mock.calls[0][0].message).toMatch(/provider.*spending ceiling/);
  expect(mocks.confirm.mock.calls[1][0].message).toMatch(/Apply.*requirement changes/);
  expect(mocks.confirm.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.suggestUrsAnswers.mock.invocationCallOrder[0],
  );
  expect(mocks.select).toHaveBeenCalledOnce();
  expect(mocks.text).not.toHaveBeenCalled();
  const saved = await loadUrs(join(root, 'urs.yaml'));
  expect(saved.open_questions[0].answer).toBe('Download a header-only CSV.');
  expect(saved.open_questions[0]).not.toHaveProperty('resolution');
  expect(saved.families).toEqual(draft.families);
});

it('does not start authoring for unattended unanswered questions', async () => {
  const { root } = await resolutionFixture(null);

  await runCli(root, ['urs', 'resolve', 'urs.yaml', '--provider', 'openai', '--yes']);

  expect(mocks.suggestUrsAnswers).not.toHaveBeenCalled();
  expect(mocks.proposeUrsResolution).not.toHaveBeenCalled();
  expect(mocks.getProviderKey).not.toHaveBeenCalled();
  expect(mocks.select).not.toHaveBeenCalled();
  expect((await loadUrs(join(root, 'urs.yaml'))).open_questions[0].answer).toBeNull();
});

it.each(['missing reference', 'duplicate requirement'])(
  'retains a structurally invalid model response without publishing a broken URS: %s',
  async (problem) => {
    const root = await fixture();
    const invalid = structuredClone(draft);
    if (problem === 'missing reference')
      invalid.families[0].requirements[0].references = ['references/not-produced.csv'];
    else
      invalid.families[0].requirements.push(structuredClone(invalid.families[0].requirements[0]));
    mocks.draftUrs.mockResolvedValueOnce({
      value: invalid,
      incomplete: false,
      questions: [],
      spend: { cap: 15, actual: 0, reserved: 0, calls: 1 },
      reviewRounds: 0,
    });
    process.argv = [
      process.execPath,
      'provenarium',
      '--project',
      root,
      'urs',
      'generate',
      '--context',
      'design.md',
      '--provider',
      'openai',
      '--yes',
      '--no-pdf',
    ];

    await import('../src/cli.js');

    expect(process.exitCode).toBe(1);
    expect(console.error).not.toHaveBeenCalled();
    expect(mocks.renderUrs).not.toHaveBeenCalled();
    await expect(readFile(join(root, 'urs.yaml'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const records = await readdir(join(root, 'drafts'));
    expect(records).toHaveLength(1);
    const retained = JSON.parse(await readFile(join(root, 'drafts', records[0]), 'utf8'));
    expect(retained.value).toEqual(invalid);
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain(
      'No requirements file was published',
    );
  },
);

it('publishes a structurally valid draft with unanswered human decisions', async () => {
  const root = await fixture();
  const withQuestion = structuredClone(draft);
  withQuestion.open_questions = [
    {
      id: 'Q-CSV',
      question: 'Should an empty register download a header-only CSV?',
      requirement: 'URS-RESULT-001',
      answer: null,
    },
  ];
  mocks.draftUrs.mockResolvedValueOnce({
    value: withQuestion,
    incomplete: false,
    questions: ['Q-CSV: Should an empty register download a header-only CSV?'],
    spend: { cap: 15, actual: 0, reserved: 0, calls: 1 },
    reviewRounds: 0,
  });

  await runCli(root, [
    'urs',
    'generate',
    '--context',
    'design.md',
    '--provider',
    'openai',
    '--yes',
    '--no-pdf',
  ]);

  expect(await loadUrs(join(root, 'urs.yaml'))).toEqual(withQuestion);
  expect(mocks.renderUrs).toHaveBeenCalledExactlyOnceWith(withQuestion, join(root, 'urs'), false);
  expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('urs resolve urs.yaml');
});

it('repairs generated source references from real linked context without authoring and still reports unanswered questions', async () => {
  const { root, document } = await resolutionFixture(null);
  const url = 'https://example.com/deployed-dilution';
  await writeFile(join(root, 'design.md'), 'OQ-CSV-EXPORT: Verify the documented CSV export.');
  const project = await loadProject(root);
  project.context = [{ id: 'design', path: 'design.md' }];
  project.target_url = url;
  await saveProject(root, project);
  document.families[0].requirements[0].references = [
    'OQ-CSV-EXPORT',
    `Hosted observation: ${url} — Download CSV`,
  ];
  const original = `# Keep this review note.\n${stringify(document)}`;
  await writeFile(join(root, 'urs.yaml'), original);
  mocks.openDiscovery.mockResolvedValueOnce({ url, text: 'Download CSV', controls: [] });
  process.argv = [
    process.execPath,
    'provenarium',
    '--project',
    root,
    'urs',
    'check',
    'urs.yaml',
    '--fix-references',
    '--yes',
  ];

  await import('../src/cli.js');

  expect(process.exitCode).toBe(1);
  expect(console.error).not.toHaveBeenCalled();
  expect(mocks.draftUrs).not.toHaveBeenCalled();
  expect(mocks.suggestUrsAnswers).not.toHaveBeenCalled();
  expect(mocks.proposeUrsResolution).not.toHaveBeenCalled();
  expect(mocks.getProviderKey).not.toHaveBeenCalled();
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(mocks.discoveryOptions).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ root, url, allowInteractions: false }),
  );
  expect(mocks.closeDiscovery).toHaveBeenCalledOnce();
  const repaired = await loadUrs(join(root, 'urs.yaml'));
  expect(repaired.document).toEqual(document.document);
  expect(repaired.open_questions).toEqual(document.open_questions);
  expect(repaired.families[0].requirements[0]).toEqual({
    ...document.families[0].requirements[0],
    references: [],
    citations: [
      { source: 'design', location: 'design.md' },
      { source: '@application', location: url },
    ],
  });
  expect(await readFile(join(root, 'urs.yaml'), 'utf8')).toContain('# Keep this review note.');
  const directory = join(root, '.provenarium', 'reference-repairs');
  const before = (await readdir(directory)).find((name) => name.endsWith('.before.yaml'))!;
  expect(await readFile(join(directory, before), 'utf8')).toBe(original);
  const output = vi.mocked(console.log).mock.calls.flat().join('\n');
  expect(output).toContain('Q-CSV: Should exporting an empty register');
  expect(output).not.toContain('missing reference');
  expect(output).not.toContain('unsafe or unreadable reference');
});

it('keeps the original draft when reference repair is declined', async () => {
  const { root, document } = await resolutionFixture(null);
  await writeFile(join(root, 'design.md'), 'OQ-CSV-EXPORT: Verify the documented CSV export.');
  const project = await loadProject(root);
  project.context = [{ id: 'design', path: 'design.md' }];
  await saveProject(root, project);
  document.families[0].requirements[0].references = ['OQ-CSV-EXPORT'];
  const original = stringify(document);
  await writeFile(join(root, 'urs.yaml'), original);
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  mocks.confirm.mockResolvedValueOnce(false);
  process.argv = [
    process.execPath,
    'provenarium',
    '--project',
    root,
    'urs',
    'check',
    'urs.yaml',
    '--fix-references',
  ];

  await import('../src/cli.js');

  expect(process.exitCode).toBe(1);
  expect(console.error).not.toHaveBeenCalled();
  expect(mocks.confirm).toHaveBeenCalledOnce();
  expect(mocks.confirm.mock.calls[0][0].message).toMatch(/reference-format repairs/);
  expect(await readFile(join(root, 'urs.yaml'), 'utf8')).toBe(original);
  expect(mocks.getProviderKey).not.toHaveBeenCalled();
  expect(mocks.openDiscovery).not.toHaveBeenCalled();
});

it('rejects authoring options for reference repair before browser or credential access', async () => {
  const { root } = await resolutionFixture(null);
  process.argv = [
    process.execPath,
    'provenarium',
    '--project',
    root,
    'urs',
    'check',
    'urs.yaml',
    '--fix-references',
    '--review',
  ];

  await import('../src/cli.js');

  expect(process.exitCode).toBe(1);
  expect(console.error).toHaveBeenCalledExactlyOnceWith(
    'Error: --fix-references does not use AI and cannot be combined with authoring options.',
  );
  expect(mocks.getProviderKey).not.toHaveBeenCalled();
  expect(mocks.openDiscovery).not.toHaveBeenCalled();
});
