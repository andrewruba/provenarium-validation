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
  proposeUrsResolution: vi.fn(),
  getProviderKey: vi.fn(),
  renderUrs: vi.fn(),
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
  proposeUrsResolution: mocks.proposeUrsResolution,
}));
vi.mock('../src/reports.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/reports.js')>()),
  renderUrs: mocks.renderUrs,
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

it('dispatches answers-only resolution without authoring or credential access', async () => {
  const { root, document } = await resolutionFixture(null);
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  mocks.text.mockResolvedValueOnce('Yes, download column headings with no data rows.');

  await runCli(root, ['urs', 'resolve', 'urs.yaml', '--answers-only']);

  expect(mocks.text).toHaveBeenCalledOnce();
  expect(mocks.proposeUrsResolution).not.toHaveBeenCalled();
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
