import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { planSchema, ursSchema } from '../src/schema.js';

const mocks = vi.hoisted(() => ({ generatePlan: vi.fn(), getProviderKey: vi.fn() }));
vi.mock('../src/credentials.js', () => ({
  getProviderKey: mocks.getProviderKey,
  forgetProviderKey: vi.fn(),
  prepareBindings: vi.fn(() => {
    throw new Error('Unexpected application credential request.');
  }),
}));
vi.mock('../src/authoring/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/authoring/index.js')>()),
  generatePlan: mocks.generatePlan,
}));

const urs = ursSchema.parse({
  schema_version: 1,
  document: {
    id: 'URS-SYNTHETIC',
    revision: '1',
    title: 'Synthetic register',
    intended_use: 'Record synthetic sample identifiers.',
  },
  families: [
    {
      id: 'entry',
      title: 'Entry',
      requirements: [
        {
          id: 'URS-001',
          title: 'Sample identifier',
          statement: 'The form shall show a labeled Sample ID entry.',
        },
      ],
    },
  ],
});
function candidate() {
  return {
    plan: planSchema.parse({
      schema_version: 1,
      runtime_version: 1,
      id: 'PLAN-SYNTHETIC',
      title: 'Synthetic register protocol',
      urs_revision: '1',
      target: { url: 'https://example.test/', allowed_origins: ['https://example.test'] },
      environment: {},
      obligations: [
        {
          id: 'OB-01',
          requirement_id: 'URS-001',
          source: 'URS-001/statement',
          statement: 'Sample ID is shown.',
          manual_case_ids: ['OQ-01'],
        },
      ],
      cases: [
        {
          id: 'OQ-01',
          title: 'Manual field accessibility review',
          classification: 'OQ',
          requirements: ['URS-001'],
          manual: true,
          manual_procedure: 'Inspect the field and its visible label.',
          manual_expected: 'The Sample ID label is clearly associated with the field.',
          steps: [],
        },
      ],
    }),
    fixtures: [],
  };
}

const roots: string[] = [];
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
  mocks.getProviderKey.mockResolvedValue('synthetic-provider-key');
});
afterEach(async () => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  if (originalIsTTY) Object.defineProperty(process.stdin, 'isTTY', originalIsTTY);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
  for (const listener of process.listeners('SIGINT'))
    if (!originalSigintListeners.has(listener)) process.removeListener('SIGINT', listener);
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runCli(value: ReturnType<typeof candidate>) {
  const root = await mkdtemp(join(tmpdir(), 'provenarium plan CLI '));
  roots.push(root);
  await writeFile(join(root, 'urs.yaml'), stringify(urs));
  mocks.generatePlan.mockResolvedValue({
    value,
    incomplete: false,
    questions: [],
    spend: { cap: 5, actual: 0, reserved: 0, calls: 0 },
    reviewRounds: 0,
  });
  process.argv = [
    process.execPath,
    'provenarium',
    '--project',
    root,
    'generate',
    '--urs',
    'urs.yaml',
    '--url',
    'https://example.test/',
    '--provider',
    'openai',
    '--thoroughness',
    'quick',
    '--yes',
    '--no-pdf',
  ];
  await import('../src/cli.js');
  return root;
}

async function authoringRecord(root: string) {
  const records = await readdir(join(root, 'drafts'));
  expect(records).toHaveLength(1);
  return JSON.parse(await readFile(join(root, 'drafts', records[0]), 'utf8'));
}

it('retains prose file references as a generation diagnostic without attempting candidate packaging', async () => {
  const value = candidate();
  value.plan.references = ['URS-SYNTHETIC, Draft 1, including its accepted human resolutions.'];
  const root = await runCli(value);

  expect(process.exitCode).toBe(1);
  expect(console.error).not.toHaveBeenCalled();
  expect(await readdir(root)).not.toContain('candidates');
  const record = await authoringRecord(root);
  expect(record.incomplete).toBe(true);
  expect(record.value.plan.references).toEqual(value.plan.references);
  expect(record.questions.join('\n')).toContain(value.plan.references[0]);
  expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain(
    'no candidate was published',
  );
  expect(vi.mocked(console.log).mock.calls.flat().join('\n')).not.toContain('ENOENT');
});

it('blocks invalid obligation bindings even if the authoring result claims completion', async () => {
  const value = candidate();
  value.plan.obligations[0].source = 'The reviewed requirement statement';
  const root = await runCli(value);

  expect(process.exitCode).toBe(1);
  expect(console.error).not.toHaveBeenCalled();
  expect(await readdir(root)).not.toContain('candidates');
  const record = await authoringRecord(root);
  expect(record.incomplete).toBe(true);
  expect(record.questions.join('\n')).toContain('OB-01');
  expect(record.questions.join('\n')).toMatch(/source/i);
});

it('publishes a structurally valid candidate while retaining genuine product questions as approval blockers', async () => {
  const value = candidate();
  value.plan.questions = [
    {
      id: 'Q-VISIBILITY',
      requirement: 'URS-001',
      question: 'Must the field remain visible for inactive users?',
    },
  ];
  const root = await runCli(value);

  expect(process.exitCode).toBeUndefined();
  expect(console.error).not.toHaveBeenCalled();
  const candidates = await readdir(join(root, 'candidates'));
  expect(candidates).toHaveLength(1);
  const questions = JSON.parse(
    await readFile(join(root, 'candidates', candidates[0], 'questions.json'), 'utf8'),
  );
  expect(questions.questions).toEqual(value.plan.questions);
  expect(questions.validation_errors.join('\n')).toContain('Q-VISIBILITY');
  expect((await authoringRecord(root)).incomplete).toBe(false);
  expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('Approval blockers:');
});
