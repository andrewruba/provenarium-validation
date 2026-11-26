import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProject } from '../src/project.js';
import { loadUrs, templateText } from '../src/urs.js';
import { ursSchema } from '../src/schema.js';

const mocks = vi.hoisted(() => ({
  draftUrs: vi.fn(),
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
  mocks.select.mockResolvedValueOnce('openai');
  mocks.confirm.mockResolvedValueOnce(true);

  await runCli(root, ['urs']);

  expect(mocks.text).toHaveBeenCalledTimes(3);
  expect(mocks.text.mock.calls.map(([options]) => options.message)).toEqual([
    expect.stringMatching(/Application source or document/),
    expect.stringMatching(/Add more context/),
    'Deployed application URL',
  ]);
  expect(mocks.select).toHaveBeenCalledOnce();
  expect(mocks.select.mock.calls[0][0].message).toBe('Authoring provider');
  expect(mocks.confirm).toHaveBeenCalledOnce();
  expect(mocks.confirm.mock.calls[0][0].message).toMatch(/provider.*spending ceiling/);
  expect(mocks.text.mock.invocationCallOrder.at(-1)).toBeLessThan(
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
    sources: [{ id: 'source-1', path: 'design.md' }],
  });
  expect(await readFile(join(root, 'urs.yaml'), 'utf8')).toBe(templateText);
  const revisions = (await readdir(root)).filter((name) => /^urs\.revision-.+\.yaml$/.test(name));
  expect(revisions).toHaveLength(1);
  expect(await loadUrs(join(root, revisions[0]))).toEqual(draft);
  expect(await loadProject(root)).toMatchObject({
    target_url: url,
    provider: 'openai',
    context: [{ id: 'source-1', path: 'design.md' }],
  });
});
