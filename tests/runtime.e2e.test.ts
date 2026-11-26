import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { observationSchema, planSchema, ursSchema } from '../src/schema.js';
import { createCandidate, approveCandidate, loadProject } from '../src/project.js';
import { executePackage } from '../src/runtime/index.js';

const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function setup(sessionEcho?: string, storageValue?: string, statusText = 'Ready') {
  const root = await mkdtemp(join(tmpdir(), 'provenarium-evidence-'));
  directories.push(root);
  const server = createServer((request, response) => {
    if (request.url === '/hang') return;
    response.setHeader('content-type', 'text/html');
    const socketTarget = new URL(request.url ?? '/', 'http://localhost').searchParams.get('socket');
    if (socketTarget) {
      response.end(
        `<html><body><p data-testid="status">Waiting</p><script>const socket = new WebSocket(${JSON.stringify(socketTarget)});socket.onopen=()=>document.querySelector('[data-testid=status]').textContent='Connected';socket.onerror=socket.onclose=()=>document.querySelector('[data-testid=status]').textContent='Blocked';</script></body></html>`,
      );
      return;
    }
    if (sessionEcho) {
      response.setHeader('set-cookie', `session=${sessionEcho}; Path=/; HttpOnly; SameSite=Lax`);
      response.end(`<html><body><p data-testid="status">Session ${sessionEcho}</p></body></html>`);
      return;
    }
    response.end(
      '<!doctype html><html><body><label>Password<input type="password" id="password"></label><button onclick="document.querySelector(\'#status\').textContent=\'Revealed \'+document.querySelector(\'#password\').value">Reveal</button><p id="status" data-testid="status">' +
        statusText +
        '</p>' +
        (storageValue === undefined
          ? ''
          : `<script>sessionStorage.setItem('preference',${JSON.stringify(storageValue)});localStorage.setItem('preference',${JSON.stringify(storageValue)});document.cookie='preference='+${JSON.stringify(storageValue)};</script>`) +
        '</body></html>',
    );
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address.');
  const url = `http://127.0.0.1:${address.port}`;
  const urs = ursSchema.parse({
    schema_version: 1,
    document: {
      id: 'URS',
      revision: '1',
      title: 'Evidence behavior',
      intended_use: 'Verify safe evidence capture.',
    },
    families: [
      {
        id: 'evidence',
        title: 'Evidence',
        requirements: [{ id: 'R1', title: 'Status', statement: 'The status shall be observable.' }],
      },
    ],
  });
  const plan = planSchema.parse({
    schema_version: 1,
    runtime_version: 1,
    id: 'PLAN',
    title: 'Evidence checks',
    urs_revision: '1',
    target: { url, allowed_origins: [url] },
    environment: { timeout_ms: 30000 },
    obligations: [
      {
        id: 'O1',
        requirement_id: 'R1',
        source: '/families/0/requirements/0/statement',
        statement: 'Status is observable.',
        assertion_ids: ['A1'],
      },
    ],
    cases: [
      {
        id: 'C1',
        title: 'Capture status',
        classification: 'OQ',
        requirements: ['R1'],
        steps: [
          {
            id: 'S1',
            instruction: 'Observe the ready status.',
            actions: [{ op: 'navigate', url: '/' }],
            assertions: [
              {
                id: 'A1',
                locator: { by: 'testId', value: 'status' },
                comparison: 'equals',
                expected: 'Ready',
              },
            ],
            evidence: [{ id: 'E1', kind: 'observation' }],
          },
        ],
      },
    ],
  });
  return { root, plan, urs };
}

describe('qualification runtime evidence', () => {
  it('runs independent automation while defined setup checks remain manual_pending', async () => {
    const { root, plan, urs } = await setup();
    plan.cases.push({
      id: 'C-MANUAL',
      title: 'Persistent status',
      classification: 'OQ',
      requirements: ['R1'],
      prerequisites: ['Prepare a disposable persistent profile.'],
      manual: true,
      manual_procedure: 'Restart the browser and inspect the status.',
      manual_expected: 'The status remains Ready.',
      steps: [],
      citations: [],
    });
    plan.obligations[0].manual_case_ids.push('C-MANUAL');
    plan.questions = [
      {
        id: 'SETUP-PROFILE',
        question: 'Prepare the persistent profile before this check.',
        kind: 'execution_preparation',
        requirement: 'R1',
        case_ids: ['C-MANUAL'],
      },
    ];
    await createCandidate(root, urs, plan, { pdf: false });
    await approveCandidate(root, { pdf: false });
    const run = await executePackage(root, undefined, { bindings: {} });
    expect(run.complete).toBe(true);
    expect(run.cases.map((c) => [c.id, c.status])).toEqual([
      ['C1', 'passed'],
      ['C-MANUAL', 'manual_pending'],
    ]);
    const records = (await readFile(join(root, 'runs', run.id, 'observations.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => observationSchema.parse(JSON.parse(line)));
    expect(
      records.some((record) => record.case_id === 'C-MANUAL' && record.status === 'passed'),
    ).toBe(false);
  });

  it('preserves trusted record and artifact metadata when a storage value is a single digit', async () => {
    const { root, plan, urs } = await setup(undefined, '1');
    plan.cases[0].steps[0].evidence.push({ id: 'E2', kind: 'screenshot', required: true });
    await createCandidate(root, urs, plan, { pdf: false });
    await approveCandidate(root, { pdf: false });
    const run = await executePackage(root, undefined, { bindings: {} });
    const records = (await readFile(join(root, 'runs', run.id, 'observations.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => observationSchema.parse(JSON.parse(line)));
    expect(run.cases[0].status).toBe('passed');
    expect(
      records.every(
        (record) =>
          record.run_id === run.id &&
          record.package_id === run.package_id &&
          record.case_id === 'C1' &&
          record.step_id === 'S1',
      ),
    ).toBe(true);
    expect(records.find((record) => record.assertion_id === 'A1')?.status).toBe('passed');
    expect(records.flatMap((record) => record.artifacts)).toEqual(run.artifacts);
    expect(run.artifacts).toHaveLength(1);
  });

  it('blocks an assertion when redaction would conceal the behavior it claims to establish', async () => {
    const { root, plan, urs } = await setup(undefined, '1', 'Value1');
    plan.cases[0].steps[0].assertions[0].expected = 'Value1';
    await createCandidate(root, urs, plan, { pdf: false });
    await approveCandidate(root, { pdf: false });
    const run = await executePackage(root, undefined, { bindings: {} });
    const records = (await readFile(join(root, 'runs', run.id, 'observations.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => observationSchema.parse(JSON.parse(line)));
    expect(run.cases[0].status).toBe('blocked');
    expect(records.find((record) => record.assertion_id === 'A1')).toMatchObject({
      status: 'blocked',
      actual: 'Value[REDACTED]',
      case_id: 'C1',
      step_id: 'S1',
    });
  });

  it('blocks WebSocket connections to origins outside the approved scope', async () => {
    const { root, plan, urs } = await setup();
    let upgrades = 0;
    const foreign = createServer();
    servers.push(foreign);
    foreign.on('upgrade', (_request, socket) => {
      upgrades++;
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      foreign.once('error', reject);
      foreign.listen(0, '127.0.0.1', resolve);
    });
    const address = foreign.address();
    if (!address || typeof address === 'string') throw new Error('No foreign server address.');
    plan.cases[0].steps[0].actions = [
      { op: 'navigate', url: `/?socket=${encodeURIComponent(`ws://127.0.0.1:${address.port}/`)}` },
    ];
    plan.cases[0].steps[0].assertions[0].expected = 'Blocked';
    await createCandidate(root, urs, plan, { pdf: false });
    await approveCandidate(root, { pdf: false });
    const run = await executePackage(root, undefined, { bindings: {} });
    expect(run.cases[0].status).toBe('passed');
    expect(upgrades).toBe(0);
  });

  it('rejects a runtime credential embedded in an approved fixture before a run starts', async () => {
    const { root, plan, urs } = await setup();
    const sentinel = 'FIXTURE-credential-must-never-be-approved';
    plan.access = [
      {
        id: 'actor',
        role: 'operator',
        state: 'active',
        mode: 'credentials',
        purpose: 'Credential boundary check.',
        cases: ['C1'],
        distinct_from: [],
      },
    ];
    plan.cases[0].actor = 'actor';
    plan.fixtures = ['fixtures/input.txt'];
    await createCandidate(root, urs, plan, {
      pdf: false,
      files: { 'fixtures/input.txt': sentinel },
    });
    await approveCandidate(root, { pdf: false });
    await expect(
      executePackage(root, undefined, {
        bindings: { actor: { username: 'synthetic', password: sentinel } },
      }),
    ).rejects.toThrow(/fixtures\/input.txt contains a runtime credential/);
    expect((await loadProject(root)).last_run).toBeUndefined();
  });

  it('redacts session cookies obtained during execution even when they were not input bindings', async () => {
    const sentinel = 'SESSION-hidden-token-89581';
    const { root, plan, urs } = await setup(sentinel);
    plan.cases[0].steps[0].assertions[0].comparison = 'contains';
    plan.cases[0].steps[0].assertions[0].expected = 'Session';
    plan.cases[0].steps[0].evidence.push({ id: 'E2', kind: 'screenshot', required: true });
    await createCandidate(root, urs, plan, { pdf: false });
    await approveCandidate(root, { pdf: false });
    const run = await executePackage(root, undefined, { bindings: {} });
    const observations = await readFile(join(root, 'runs', run.id, 'observations.jsonl'), 'utf8');
    expect(run.cases[0].status).toBe('blocked');
    expect(observations).toContain('[REDACTED]');
    expect(observations).not.toContain(sentinel);
    expect(await readdir(join(root, 'runs', run.id, 'artifacts'))).toEqual([]);
  });

  it('rejects credential-bearing screenshots and redacts structured observations', async () => {
    const { root, plan, urs } = await setup();
    const sentinel = 'SENTINEL-secret-never-retain-19';
    plan.access = [
      {
        id: 'actor',
        role: 'operator',
        state: 'active',
        mode: 'credentials',
        purpose: 'Exercise credential-aware capture.',
        cases: ['C1'],
        distinct_from: [],
      },
    ];
    plan.cases[0].actor = 'actor';
    plan.cases[0].steps[0].actions.push(
      {
        op: 'fillSecret',
        locator: { by: 'label', value: 'Password', exact: true },
        binding: 'actor.password',
      },
      { op: 'click', locator: { by: 'role', role: 'button', value: 'Reveal', exact: true } },
    );
    plan.cases[0].steps[0].assertions[0].comparison = 'contains';
    plan.cases[0].steps[0].assertions[0].expected = 'Revealed';
    plan.cases[0].steps[0].evidence.push({ id: 'E2', kind: 'screenshot', required: true });
    await createCandidate(root, urs, plan, { pdf: false });
    await approveCandidate(root, { pdf: false });
    const run = await executePackage(root, undefined, {
      bindings: { actor: { username: 'synthetic', password: sentinel } },
    });
    expect(run.complete).toBe(true);
    expect(run.cases[0].status).toBe('blocked');
    const observations = await readFile(join(root, 'runs', run.id, 'observations.jsonl'), 'utf8');
    expect(observations).toContain('[REDACTED]');
    expect(observations).not.toContain(sentinel);
    expect(JSON.stringify(run)).not.toContain(sentinel);
    expect(await readdir(join(root, 'runs', run.id, 'artifacts'))).toEqual([]);
  });

  it('retains earlier evidence and leaves an interrupted run incomplete', async () => {
    const { root, plan, urs } = await setup();
    plan.cases[0].steps.push({
      id: 'S2',
      instruction: 'Wait for an unavailable page.',
      actions: [{ op: 'navigate', url: '/hang' }],
      assertions: [],
      evidence: [],
    });
    await createCandidate(root, urs, plan, { pdf: false });
    await approveCandidate(root, { pdf: false });
    const controller = new AbortController();
    const pending = executePackage(root, undefined, { bindings: {}, signal: controller.signal });
    let found = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = await loadProject(root);
      if (current.last_run) {
        const observations = await readFile(
          join(root, 'runs', current.last_run, 'observations.jsonl'),
          'utf8',
        ).catch(() => '');
        if (observations.includes('"assertion_id":"A1"')) {
          found = true;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    controller.abort();
    const run = await pending;
    expect(found).toBe(true);
    expect(run.complete).toBe(false);
    expect(await readFile(join(root, 'runs', run.id, 'observations.jsonl'), 'utf8')).toContain(
      '"assertion_id":"A1"',
    );
  });
});
