import { providerOutputText } from './provider-fixture.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import { planSchema, ursSchema, type Plan, type Urs } from '../src/schema.js';
import { createCandidate, loadProject } from '../src/project.js';

const mocks = vi.hoisted(() => ({
  generatePlan: vi.fn(),
  getProviderKey: vi.fn(),
  fetchImpl: vi.fn(),
  perform: vi.fn(),
  close: vi.fn(),
}));
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
vi.mock('../src/authoring/discovery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/authoring/discovery.js')>()),
  Discovery: class {
    async open() {
      return {
        url: 'https://example.test/',
        title: 'Synthetic register',
        text: 'Sample ID',
        controls: [{ label: 'Sample ID', type: 'text' }],
        links: [],
      };
    }
    perform = mocks.perform;
    close = mocks.close;
  },
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

async function runCli(
  value: ReturnType<typeof candidate>,
  providerValues?: unknown[],
  prior?: {
    plan: Plan;
    fixtures: { path: string; content: string | Buffer }[];
    urs?: Urs;
    nextUrs?: Urs;
    projectFiles?: Record<string, string | Buffer>;
  },
) {
  const root = await mkdtemp(join(tmpdir(), 'provenarium plan CLI '));
  roots.push(root);
  await writeFile(join(root, 'urs.yaml'), stringify(prior?.nextUrs ?? urs));
  for (const [name, contents] of Object.entries(prior?.projectFiles ?? {})) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), contents);
  }
  if (prior) {
    await createCandidate(root, prior.urs ?? urs, prior.plan, {
      files: Object.fromEntries(prior.fixtures.map((fixture) => [fixture.path, fixture.content])),
      pdf: false,
    });
    await writeFile(join(root, 'feedback.txt'), 'Add a second manual accessibility review.');
  }
  if (providerValues) {
    const { generatePlan } = await vi.importActual<typeof import('../src/authoring/index.js')>(
      '../src/authoring/index.js',
    );
    mocks.fetchImpl.mockImplementation(async (_url: unknown, requestOptions?: RequestInit) => {
      const output = providerValues.shift();
      if (output === undefined) throw new Error('Unexpected additional provider request.');
      return new Response(
        JSON.stringify({
          status: 'completed',
          usage: { input_tokens: 100, output_tokens: 50 },
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: providerOutputText(requestOptions, output),
                },
              ],
            },
          ],
        }),
      );
    });
    mocks.generatePlan.mockImplementation((options) =>
      generatePlan({ ...options, fetchImpl: mocks.fetchImpl }),
    );
  } else {
    mocks.generatePlan.mockResolvedValue({
      value,
      incomplete: false,
      questions: [],
      spend: { cap: 5, actual: 0, reserved: 0, calls: 0 },
      reviewRounds: 0,
    });
  }
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
    ...(prior ? ['--feedback', 'feedback.txt'] : []),
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

it('persists redacted rejected responses and field diagnostics when schema corrections are exhausted', async () => {
  const malformed = candidate();
  malformed.plan.cases[0].classification = 'PQ' as never;
  malformed.plan.title = 'Synthetic protocol with synthetic-provider-key in rejected output';
  const root = await runCli(malformed, [{ action: 'finish' }, malformed, malformed, malformed]);

  expect(process.exitCode).toBe(1);
  expect(console.error).not.toHaveBeenCalled();
  expect(mocks.fetchImpl).toHaveBeenCalledTimes(4);
  expect(mocks.perform).not.toHaveBeenCalled();
  expect(await readdir(root)).not.toContain('candidates');
  const record = await authoringRecord(root);
  expect(record.incomplete).toBe(true);
  expect(record.value).toBeUndefined();
  expect(record.diagnostics).toHaveLength(3);
  expect(record.diagnostics[0]).toMatchObject({
    operation: 'protocol draft',
    kind: 'document_schema',
    candidate: {
      plan: { title: 'Synthetic protocol with [REDACTED] in rejected output' },
    },
    issues: expect.arrayContaining([
      expect.objectContaining({ path: '/plan/cases/0/classification', code: 'invalid_value' }),
    ]),
  });
  expect(JSON.stringify(record)).not.toContain('synthetic-provider-key');
  const output = vi.mocked(console.log).mock.calls.flat().join('\n');
  expect(output).toContain('Authoring diagnostics:');
  expect(output).toContain('INCOMPLETE:');
});

it('publishes a repaired plan without turning technical diagnostics into approval questions', async () => {
  const malformed = candidate();
  malformed.plan.cases[0].classification = 'PQ' as never;
  const root = await runCli(candidate(), [
    { action: 'finish' },
    malformed,
    candidate(),
    { findings: [], summary: 'No further findings.' },
  ]);

  expect(process.exitCode).toBeUndefined();
  expect(console.error).not.toHaveBeenCalled();
  expect(mocks.fetchImpl).toHaveBeenCalledTimes(4);
  const record = await authoringRecord(root);
  expect(record.incomplete).toBe(false);
  expect(record.diagnostics).toHaveLength(1);
  expect(record.questions).toEqual([]);
  const candidates = await readdir(join(root, 'candidates'));
  expect(candidates).toHaveLength(1);
  const questions = JSON.parse(
    await readFile(join(root, 'candidates', candidates[0], 'questions.json'), 'utf8'),
  );
  expect(questions.questions).toEqual([]);
  expect(questions.validation_errors).toEqual([]);
  expect(vi.mocked(console.log).mock.calls.flat().join('\n')).not.toContain('Approval blockers:');
});

it('loads existing fixture and generated reference contents and preserves them through scoped revision', async () => {
  const value = candidate();
  value.plan.fixtures = ['fixtures/sample.csv'];
  value.plan.references = ['fixtures/derivation.txt'];
  const fixtures = [
    { path: 'fixtures/sample.csv', content: '\uFEFFsample,value\r\nα,1.250\r\n' },
    { path: 'fixtures/derivation.txt', content: 'Accepted derivation: 5 ÷ 4 = 1.250.\r\n' },
  ];
  const newCase = {
    ...structuredClone(value.plan.cases[0]),
    id: 'OQ-02',
    title: 'Additional manual accessibility review',
  };
  const root = await runCli(
    value,
    [
      { action: 'finish' },
      {
        edits: [
          { op: 'add_case', value: newCase },
          {
            op: 'add_obligation',
            value: {
              ...structuredClone(value.plan.obligations[0]),
              id: 'OB-02',
              manual_case_ids: ['OQ-02'],
            },
          },
        ],
      },
      { findings: [], summary: 'Coverage is complete.' },
    ],
    { plan: value.plan, fixtures },
  );

  expect(process.exitCode).toBeUndefined();
  expect(console.error).not.toHaveBeenCalled();
  expect(mocks.generatePlan.mock.calls[0][0].existingFixtures).toEqual(fixtures);
  expect(mocks.fetchImpl).toHaveBeenCalledTimes(3);
  const project = await loadProject(root);
  const revisedDirectory = join(root, project.current_candidate!);
  const revised = planSchema.parse(
    JSON.parse(await readFile(join(revisedDirectory, 'plan.json'), 'utf8')),
  );
  expect(revised.fixtures).toEqual(value.plan.fixtures);
  expect(revised.references).toEqual(value.plan.references);
  expect(revised.cases[0]).toEqual(value.plan.cases[0]);
  expect(revised.cases[1]).toEqual(newCase);
  expect(revised.obligations[0]).toEqual(value.plan.obligations[0]);
  for (const fixture of fixtures)
    expect(await readFile(join(revisedDirectory, fixture.path))).toEqual(
      Buffer.from(fixture.content),
    );
  expect(await readdir(join(root, 'candidates'))).toHaveLength(2);
  expect((await authoringRecord(root)).incomplete).toBe(false);
});

it.each([
  {
    path: 'fixtures/upload.pdf',
    content: Buffer.from('%PDF-1.7\n'),
    message: /supported generated text fixture/,
  },
  { path: 'fixtures/input.txt', content: Buffer.from([0xff, 0xfe, 0x41]), message: /valid UTF-8/ },
])(
  'rejects unsupported prior input $path before authoring or requesting a key',
  async (fixture) => {
    const value = candidate();
    value.plan.fixtures = [fixture.path];
    const root = await runCli(value, undefined, { plan: value.plan, fixtures: [fixture] });

    expect(process.exitCode).toBe(1);
    expect(mocks.generatePlan).not.toHaveBeenCalled();
    expect(mocks.getProviderKey).not.toHaveBeenCalled();
    const errors = vi.mocked(console.error).mock.calls.flat().join('\n');
    expect(errors).toMatch(fixture.message);
    expect(errors).toContain('--plan');
    expect(errors).toContain('No provider request was sent');
    expect(await readdir(join(root, 'candidates'))).toHaveLength(1);
    expect(await readdir(root)).not.toContain('drafts');
  },
);

it('replaces retired normative DOCX references without decoding the old document as a text fixture', async () => {
  const { default: JSZip } = await import('jszip');
  const archive = new JSZip();
  archive.file(
    'word/document.xml',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>The Sample ID label is associated with the field.</w:t></w:r></w:p></w:body></w:document>',
  );
  const nextDocx = await archive.generateAsync({ type: 'nodebuffer' });
  const previousUrs = structuredClone(urs);
  previousUrs.families[0].requirements[0].references = ['references/old.docx'];
  const nextUrs = structuredClone(previousUrs);
  nextUrs.document.revision = '2';
  nextUrs.families[0].requirements[0].references = ['references/new.docx'];
  const value = candidate();
  value.plan.references = ['references/old.docx'];
  const root = await runCli(
    value,
    [{ action: 'finish' }, { edits: [] }, { findings: [], summary: 'Reference update reviewed.' }],
    {
      plan: value.plan,
      fixtures: [{ path: 'references/old.docx', content: Buffer.from([0x50, 0x4b, 0xff, 0xfe]) }],
      urs: previousUrs,
      nextUrs,
      projectFiles: { 'references/new.docx': nextDocx },
    },
  );

  expect(process.exitCode).toBeUndefined();
  expect(console.error).not.toHaveBeenCalled();
  expect(mocks.generatePlan.mock.calls[0][0].existingFixtures).toEqual([]);
  expect(mocks.fetchImpl).toHaveBeenCalledTimes(3);
  const project = await loadProject(root);
  const revisedDirectory = join(root, project.current_candidate!);
  const revised = planSchema.parse(
    JSON.parse(await readFile(join(revisedDirectory, 'plan.json'), 'utf8')),
  );
  expect(revised.urs_revision).toBe('2');
  expect(revised.references).toEqual(['references/new.docx']);
  expect(revised.cases).toEqual(value.plan.cases);
  expect(await readFile(join(revisedDirectory, 'references/new.docx'))).toEqual(nextDocx);
  expect(await readdir(join(revisedDirectory, 'references'))).toEqual(['new.docx']);
  expect((await authoringRecord(root)).incomplete).toBe(false);
});
