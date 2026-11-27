import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sha256 } from '../src/files.js';
import { loadProject } from '../src/project.js';
import { approvalSchema, planSchema, runSchema, ursSchema } from '../src/schema.js';
import { loadUrs, questionStatus } from '../src/urs.js';
import { providerOutputText } from './provider-fixture.js';
import { resolutionProviderValue } from './resolution-fixture.js';

const prompts = vi.hoisted(() => ({
  confirm: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  getProviderKey: vi.fn(),
}));
vi.mock('@clack/prompts', () => ({
  confirm: prompts.confirm,
  select: prompts.select,
  text: prompts.text,
  isCancel: (value: unknown) => typeof value === 'symbol',
}));
vi.mock('../src/credentials.js', async (original) => ({
  ...(await original<typeof import('../src/credentials.js')>()),
  getProviderKey: prompts.getProviderKey,
}));

const urs = ursSchema.parse({
  schema_version: 1,
  document: {
    id: 'URS-REGISTER',
    revision: '1',
    title: 'Sample register',
    intended_use: 'Record synthetic sample identifiers.',
  },
  families: [
    {
      id: 'records',
      title: 'Records',
      requirements: [
        {
          id: 'URS-SAVE',
          title: 'Save a sample',
          statement: 'Allow users to save sample identifiers.',
        },
      ],
    },
  ],
});
const confirmation = 'Saving a Sample ID displays Saved followed by the identifier.';
const reviewed = structuredClone(urs);
reviewed.families[0].requirements[0].statement = confirmation;
const draft = ursSchema.parse({
  ...urs,
  open_questions: [
    {
      id: 'Q-SAVED',
      requirement: 'URS-SAVE',
      question: 'How does the register confirm a successful save?',
      answer: null,
    },
  ],
});
const resolution = resolutionProviderValue({
  requirements: [
    {
      question_ids: ['Q-SAVED'],
      value: reviewed.families[0].requirements[0],
      reason: 'Record the supplied save confirmation.',
    },
  ],
  unresolved: [],
});
const recommendations = {
  suggestions: [
    {
      question_id: 'Q-SAVED',
      answer: confirmation,
      basis: 'documented',
      explanation: 'The design specifies the saved message.',
      citations: [{ source: 'source-1', location: 'design.md' }],
      choices: [],
    },
  ],
};

function generated(url: string, revision: string, exactSave = true) {
  return {
    plan: planSchema.parse({
      schema_version: 1,
      runtime_version: 1,
      id: 'IOQ-REGISTER',
      title: 'Sample register qualification',
      urs_revision: revision,
      target: { url, allowed_origins: [new URL(url).origin] },
      environment: { timeout_ms: 1500 },
      obligations: [
        {
          id: 'OB-SAVE',
          requirement_id: 'URS-SAVE',
          source: 'URS-SAVE/statement',
          statement: confirmation,
          assertion_ids: ['A-SAVED'],
        },
      ],
      cases: [
        {
          id: 'OQ-SAVE',
          title: 'Confirm a saved sample',
          classification: 'OQ',
          requirements: ['URS-SAVE'],
          steps: [
            {
              id: '01',
              instruction: 'Save the synthetic identifier and check the displayed message.',
              actions: [
                { op: 'navigate', url: '/' },
                { op: 'fill', locator: { by: 'label', value: 'Sample ID' }, value: 'SYNTH-1' },
                {
                  op: 'click',
                  locator: { by: 'role', role: 'button', value: 'Save', exact: exactSave },
                },
              ],
              assertions: [
                {
                  id: 'A-SAVED',
                  locator: { by: 'css', value: '#confirmation' },
                  read: 'text',
                  comparison: 'equals',
                  expected: 'Saved SYNTH-1',
                },
              ],
            },
          ],
        },
      ],
    }),
    fixtures: [],
  };
}

const directories: string[] = [];
const servers: Server[] = [];
const argv = process.argv;
const exitCode = process.exitCode;
const isTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
let signalListeners: Set<NodeJS.SignalsListener>;

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  process.exitCode = undefined;
  signalListeners = new Set(process.listeners('SIGINT'));
  prompts.getProviderKey.mockResolvedValue('synthetic-provider-key');
  prompts.select.mockImplementation(async ({ message }) => {
    expect(message).toMatch(/review recommendations/i);
    return 'accept';
  });
});

afterEach(async () => {
  process.argv = argv;
  process.exitCode = exitCode;
  if (isTTY) Object.defineProperty(process.stdin, 'isTTY', isTTY);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
  for (const listener of process.listeners('SIGINT'))
    if (!signalListeners.has(listener)) process.removeListener('SIGINT', listener);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture({ defective = false, existing = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'provenarium-guided-validation-'));
  directories.push(root);
  await writeFile(join(root, 'design.md'), confirmation);
  if (existing) await writeFile(join(root, 'urs.yaml'), stringify(reviewed));
  const saves: string[] = [];
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/save?')) {
      saves.push(new URL(request.url, 'http://loopback.test').searchParams.get('id')!);
      response.end('');
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end(
      `<!doctype html><title>Sample register</title><form><label>Sample ID <input id="sample"></label><button>Save</button><button type="button">Save draft</button><output id="confirmation"></output></form><script>document.forms[0].onsubmit = async (event) => {event.preventDefault(); const id=document.querySelector('#sample').value; await fetch('/save?id='+encodeURIComponent(id)); document.querySelector('#confirmation').textContent=${defective ? '"Save failed"' : '"Saved "+id'};};</script>`,
    );
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No application address.');
  return {
    root,
    url: `http://127.0.0.1:${address.port}/`,
    saves,
    fixApplication() {
      defective = false;
    },
  };
}

function mockProvider(replies: Array<() => unknown>) {
  const fetch = vi.fn(async (url: string, options: RequestInit) => {
    expect(url).toBe('https://api.openai.com/v1/responses');
    const reply = replies.shift();
    if (!reply) throw new Error('Unexpected provider request.');
    return new Response(
      JSON.stringify({
        status: 'completed',
        usage: { input_tokens: 100, output_tokens: 50 },
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: providerOutputText(options, reply()) }],
          },
        ],
      }),
    );
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

async function validate({ root, url }: { root: string; url: string }) {
  process.argv = [
    process.execPath,
    'provenarium',
    '--project',
    root,
    'validate',
    '--url',
    url,
    '--context',
    'design.md',
    '--provider',
    'openai',
    '--yes',
    '--no-pdf',
  ];
  await import('../src/cli.js');
}

it('drafts, resolves and approves the URS before creating, dry-running and executing the IOQ', async () => {
  const app = await fixture();
  let stageApproved = false;
  const provider = mockProvider([
    () => draft,
    () => recommendations,
    () => resolution,
    () => {
      expect(stageApproved).toBe(true);
      return generated(app.url, '2', false);
    },
  ]);
  prompts.confirm.mockImplementationOnce(async ({ message }) => {
    expect(message).toMatch(/approve.*requirements/i);
    expect(provider).toHaveBeenCalledTimes(3);
    const saved = await loadUrs(join(app.root, 'urs.yaml'));
    expect(questionStatus(saved, saved.open_questions[0])).toBe('resolved');
    expect(app.saves).toEqual([]);
    stageApproved = true;
    return true;
  });
  await validate(app);

  expect(console.error).not.toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();
  expect(provider).toHaveBeenCalledTimes(4);
  expect(prompts.getProviderKey).toHaveBeenCalledOnce();
  expect(prompts.confirm).toHaveBeenCalledOnce();
  expect(prompts.text).not.toHaveBeenCalled();
  expect(app.saves).toEqual(['SYNTH-1', 'SYNTH-1']);

  const project = await loadProject(app.root);
  expect(project.current_candidate).toBeDefined();
  expect(project.current_package).toBeDefined();
  expect(project.last_run).toBeDefined();
  const packagePath = join(app.root, 'packages', project.current_package!);
  const approval = approvalSchema.parse(
    JSON.parse(await readFile(join(packagePath, 'approval.json'), 'utf8')),
  );
  const packagedUrs = await loadUrs(join(packagePath, 'urs.yaml'));
  const packagedPlan = planSchema.parse(
    JSON.parse(await readFile(join(packagePath, 'plan.json'), 'utf8')),
  );
  expect(packagedPlan.cases[0].steps[0].actions[2]).toMatchObject({
    op: 'click',
    locator: { value: 'Save', exact: true },
  });
  expect(approval).toHaveProperty(
    'requirements_approval',
    expect.objectContaining({
      urs_sha256: sha256(JSON.stringify(packagedUrs)),
      target_url: app.url,
      rehearsal_plan_sha256: sha256(JSON.stringify(packagedPlan)),
    }),
  );
  expect(await readFile(join(packagePath, 'ioq.html'), 'utf8')).toContain('Confirm a saved sample');
  expect(await readdir(join(packagePath, 'tests'))).toEqual(['OQ-SAVE.spec.cjs']);
  const runPath = join(app.root, 'runs', project.last_run!);
  const run = runSchema.parse(JSON.parse(await readFile(join(runPath, 'run.json'), 'utf8')));
  expect(run).toMatchObject({
    package_id: project.current_package,
    complete: true,
    cases: [{ id: 'OQ-SAVE', status: 'passed' }],
  });
  expect(await readFile(join(runPath, 'reports', 'executed-record.html'), 'utf8')).toContain(
    'OQ-SAVE',
  );
  expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('executed-record.html');
});

it('stops after a failed dry run and reuses the exact IOQ after the application is fixed', async () => {
  const app = await fixture({ defective: true, existing: true });
  const provider = mockProvider([() => generated(app.url, '1')]);
  prompts.confirm.mockResolvedValueOnce(true);
  await validate(app);

  expect(process.exitCode).toBe(1);
  expect(provider).toHaveBeenCalledOnce();
  expect(app.saves).toEqual(['SYNTH-1']);
  const project = await loadProject(app.root);
  expect(project.current_candidate).toBeDefined();
  expect(project.current_package).toBeUndefined();
  expect(project.last_run).toBeUndefined();
  const reports = await readdir(join(app.root, 'drafts'));
  const records = await Promise.all(
    reports.map(async (report) =>
      JSON.parse(await readFile(join(app.root, 'drafts', report), 'utf8')),
    ),
  );
  expect(
    records.some((record) =>
      record.rehearsal?.cases.some(
        (result: { id: string; status: string }) =>
          result.id === 'OQ-SAVE' && result.status === 'failed',
      ),
    ),
  ).toBe(true);

  app.fixApplication();
  vi.resetModules();
  process.exitCode = undefined;
  prompts.confirm.mockResolvedValueOnce(true);
  await validate(app);

  const complete = await loadProject(app.root);
  expect(process.exitCode).toBeUndefined();
  expect(console.error).not.toHaveBeenCalled();
  expect(provider).toHaveBeenCalledOnce();
  expect(prompts.getProviderKey).toHaveBeenCalledOnce();
  expect(app.saves).toEqual(['SYNTH-1', 'SYNTH-1', 'SYNTH-1']);
  expect(complete.current_candidate).toBe(project.current_candidate);
  expect(complete.current_package).toBeDefined();
  expect(complete.last_run).toBeDefined();
});

it('requires explicit approval of existing requirements even with provider consent supplied', async () => {
  const app = await fixture({ existing: true });
  const provider = mockProvider([]);
  prompts.confirm.mockResolvedValueOnce(false);
  await validate(app);

  expect(prompts.confirm).toHaveBeenCalledOnce();
  expect(prompts.getProviderKey).not.toHaveBeenCalled();
  expect(provider).not.toHaveBeenCalled();
  expect(app.saves).toEqual([]);
  const project = await loadProject(app.root);
  expect(project.current_candidate).toBeUndefined();
  expect(project.current_package).toBeUndefined();
  expect(project.last_run).toBeUndefined();
});
