import { afterEach, expect, it, vi } from 'vitest';
import { get } from 'node:http';
import { spawn } from 'node:child_process';
import { load } from 'cheerio';
import { startDilutionApp } from '../examples/dilution-app/server.ts';

const apps: Awaited<ReturnType<typeof startDilutionApp>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function start() {
  const app = await startDilutionApp({
    port: 0,
    host: '0.0.0.0',
    defects: [],
    commit: 'a'.repeat(40),
  });
  apps.push(app);
  return app;
}
const preparation = {
  sampleId: 'SHARED-ID',
  stockConcentration: '10',
  stockUnit: 'mg/mL',
  targetConcentration: '2',
  targetUnit: 'mg/mL',
  finalVolume: '10',
  volumeUnit: 'mL',
};
async function save(base: string, values = preparation) {
  return fetch(`${base}/api/plans`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(values),
  });
}
async function records(base: string) {
  return (await fetch(`${base}/api/plans`)).json();
}
function rawStatus(base: string, path: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const request = get(base, { path }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
  });
}

it('isolates hosted records, browser links, exports and resets from other visitors', async () => {
  const app = await start();
  const first = `${app.url}/w/workspace_one`;
  const second = `${app.url}/w/workspace_two`;
  const initial = await fetch(`${first}/health`);
  expect(await initial.json()).toEqual({
    status: 'ok',
    application: 'Dilution Bench',
    mode: 'correct',
    commit: 'a'.repeat(40),
  });
  expect(initial.headers.get('x-dilution-workspace')).toBe('workspace_one');
  const generation = initial.headers.get('x-dilution-generation');
  expect(generation).toMatch(/^[0-9a-f-]{36}$/);
  expect((await fetch(`${second}/health`)).headers.get('x-dilution-instance')).toBe(
    initial.headers.get('x-dilution-instance'),
  );

  const redirect = await fetch(first, { redirect: 'manual' });
  expect(redirect.status).toBe(308);
  expect(redirect.headers.get('location')).toBe('/w/workspace_one/');
  const $ = load(await (await fetch(`${first}/`)).text());
  expect($('a[href], form[action]').length).toBeGreaterThan(4);
  $('a[href], form[action]').each((_index, element) => {
    expect($(element).attr('href') ?? $(element).attr('action')).toMatch(/^\/w\/workspace_one\//);
  });
  expect(
    $('button')
      .map((_index, element) => $(element).text())
      .get(),
  ).toContain('Clear preparations');
  const formResponse = await fetch(`${first}/plans`, {
    method: 'POST',
    body: new URLSearchParams(preparation),
  });
  expect(formResponse.status).toBe(201);
  expect(formResponse.headers.get('x-dilution-generation')).toBe(generation);
  expect(await records(second)).toEqual({ plans: [] });
  expect(await records(app.url)).toEqual({ plans: [] });
  expect((await save(second, { ...preparation, finalVolume: '5' })).status).toBe(201);
  const csv = await (await fetch(`${first}/export.csv`)).text();
  expect(csv).toContain('SHARED-ID,10.000,2.000,10.000,2.000,8.000\r\n');
  expect(await (await fetch(`${first}/records`)).text()).toContain(
    'data-testid="record-SHARED-ID"',
  );

  const reset = await fetch(`${first}/reset`, { method: 'POST', redirect: 'manual' });
  expect(reset.status).toBe(303);
  expect(reset.headers.get('location')).toBe('/w/workspace_one/');
  expect(reset.headers.get('x-dilution-generation')).not.toBe(generation);
  expect(await records(first)).toEqual({ plans: [] });
  expect((await records(second)).plans[0].finalMl).toBe(5);
  expect((await fetch(`${app.url}/reset`, { method: 'POST' })).status).toBe(404);
});

it('rejects malformed workspace paths without falling back to the shared register', async () => {
  const app = await start();
  expect((await save(app.url)).status).toBe(201);
  for (const path of [
    '/w',
    '/w/short/api/plans',
    '/w/bad%20workspace/api/plans',
    '/w/workspace_one/../../api/plans',
    '/w/workspace_one/%2e%2e/%2e%2e/api/plans',
    '/w/workspace_one//api/plans',
    '/w/workspace_one\\..\\api/plans',
  ])
    expect(await rawStatus(app.url, path), path).toBe(404);
  expect((await records(app.url)).plans).toHaveLength(1);
});

it('bounds public workspace allocation and changes generation when idle data expires', async () => {
  const app = await start();
  const initial = await fetch(`${app.url}/w/workspace_000/health`);
  expect((await save(`${app.url}/w/workspace_000`)).status).toBe(201);
  for (let index = 1; index < 100; index++)
    expect(
      (await fetch(`${app.url}/w/workspace_${String(index).padStart(3, '0')}/health`)).status,
    ).toBe(200);
  expect((await fetch(`${app.url}/w/workspace_100/health`)).status).toBe(503);
  expect((await records(`${app.url}/w/workspace_000`)).plans).toHaveLength(1);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60 * 60 * 1000 + 1);
  const expired = await fetch(`${app.url}/w/workspace_000/health`);
  expect(expired.status).toBe(200);
  expect(expired.headers.get('x-dilution-generation')).not.toBe(
    initial.headers.get('x-dilution-generation'),
  );
  expect(await records(`${app.url}/w/workspace_000`)).toEqual({ plans: [] });
  expect((await fetch(`${app.url}/w/workspace_100/health`)).status).toBe(200);
});

it('limits record growth while retaining existing preparations', async () => {
  const app = await start();
  const base = `${app.url}/w/record_limit`;
  for (let index = 0; index < 500; index++)
    expect((await save(base, { ...preparation, sampleId: `SAMPLE-${index}` })).status).toBe(201);
  expect((await save(base, { ...preparation, sampleId: 'OVER-LIMIT' })).status).toBe(503);
  expect((await records(base)).plans).toHaveLength(500);
  expect((await save(base, { ...preparation, sampleId: 'SAMPLE-0' })).status).toBe(409);
});

it('uses hosting environment settings and lets explicit CLI flags override them', async () => {
  for (const override of [false, true]) {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      HOST: override ? 'invalid-host-must-not-be-used' : '0.0.0.0',
      PORT: override ? 'invalid-port-must-not-be-used' : '0',
      DILUTION_MODE: 'correct',
      APP_COMMIT: 'b'.repeat(40),
    };
    delete environment.RENDER_GIT_COMMIT;
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        'examples/dilution-app/server.ts',
        ...(override ? ['--host', '127.0.0.1', '--port', '0', '--mode', 'faulty'] : []),
      ],
      { env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    let output = '';
    try {
      const url = await new Promise<string>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', () => reject(new Error('Application exited before listening.')));
        child.stdout.on('data', (chunk) => {
          output += chunk.toString();
          const match = /Dilution Bench: (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
          if (match) resolve(match[1]);
        });
      });
      expect(await (await fetch(`${url}/health`)).json()).toEqual({
        status: 'ok',
        application: 'Dilution Bench',
        mode: override ? 'faulty' : 'correct',
        commit: 'b'.repeat(40),
      });
    } finally {
      child.kill('SIGTERM');
      await exited;
    }
  }
});
