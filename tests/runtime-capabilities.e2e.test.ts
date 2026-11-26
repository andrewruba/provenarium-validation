import { afterEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExecutionEngine } from '../src/runtime/engine.js';
import { atomicJson, readRun } from '../src/runtime/io.js';
import { planSchema, type Action } from '../src/schema.js';

const directories: string[] = [];
const servers: Server[] = [];
const browsers: Browser[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(browsers.splice(0).map((browser) => browser.close()));
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

const application = `<!doctype html><html><body>
<p id="record"></p><p id="session"></p><p id="result">Untouched</p>
<button id="save">Save</button><button id="confirm">Clear</button><button id="quiet">Quiet</button>
<button id="export">Export</button><button id="invalid">Invalid bytes</button>
<button id="empty">Empty export</button><button id="disabled" disabled>Disabled export</button>
<a id="records" href="#records">Records</a>
<table id="table" hidden><tr><th>Name</th></tr><tr><td>Saved record</td></tr></table>
<script>
function refresh() {
  try {
    document.querySelector('#record').textContent=localStorage.getItem('record') ? 'Saved record' : 'No record';
    document.querySelector('#session').textContent=sessionStorage.getItem('record') ? 'Session present' : 'No session';
  } catch { document.querySelector('#record').textContent='Storage unavailable'; }
}
refresh(); addEventListener('storage',refresh);
document.querySelector('#save').onclick=()=>{localStorage.setItem('record',JSON.stringify({name:'Saved record'}));sessionStorage.setItem('record',JSON.stringify({name:'Session value'}));refresh();};
document.querySelector('#confirm').onclick=()=>{document.querySelector('#result').textContent=confirm('Clear all records?')?'Accepted':'Dismissed';};
document.querySelector('#quiet').onclick=()=>{document.querySelector('#result').textContent='No dialog';};
function download(bytes,name){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([bytes]));a.download=name;a.click();}
document.querySelector('#export').onclick=()=>download('\ufeffid,name\\r\\n1,café\\r\\n','records.csv');
document.querySelector('#invalid').onclick=()=>download(new Uint8Array([255,10]),'invalid.bin');
document.querySelector('#empty').onclick=()=>download('','empty.csv');
addEventListener('hashchange',()=>setTimeout(()=>document.querySelector('#table').hidden=false,150));
</script></body></html>`;

const locator = (value: string) => ({ by: 'css' as const, value: `#${value}` });
const variable = (id: string, name: string, expected: unknown) => ({
  id,
  variable: name,
  comparison: 'equals',
  expected,
});
const visibleText = (id: string, selector: string, expected: string) => ({
  id,
  locator: locator(selector),
  comparison: 'equals',
  expected,
});
const step = (id: string, actions: Action[], assertions: unknown[] = []) => ({
  id,
  instruction: id,
  actions,
  assertions,
});

async function execute(steps: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), 'provenarium-capabilities-'));
  directories.push(root);
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(application);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server address.');
  const url = `http://127.0.0.1:${address.port}`;
  const plan = planSchema.parse({
    schema_version: 1,
    runtime_version: 1,
    id: 'PLAN',
    title: 'Browser capabilities',
    urs_revision: '1',
    target: { url, allowed_origins: [url] },
    environment: { timeout_ms: 1500 },
    obligations: [],
    cases: [
      {
        id: 'CASE',
        title: 'Exercise actual browser behavior',
        classification: 'OQ',
        requirements: ['R1'],
        steps,
      },
    ],
  });
  const runDirectory = join(root, 'run');
  await atomicJson(join(runDirectory, 'run.json'), {
    id: 'RUN',
    package_id: 'PLAN',
    versions: {},
    cases: [{ id: 'CASE', status: 'not_run' }],
    artifacts: [],
  });
  const browser = await chromium.launch({ headless: true });
  browsers.push(browser);
  const engine = new ExecutionEngine(
    { projectRoot: root, packageDirectory: root, runDirectory, tests: [], socketPath: '' },
    plan,
    {},
  );
  await engine.setBrowser(browser);
  let error: unknown;
  try {
    await engine.executeCase('CASE');
  } catch (caught) {
    error = caught;
  }
  const run = await readRun(runDirectory);
  const observations = (await readFile(join(runDirectory, 'observations.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  return { run, observations, error, runDirectory };
}

describe('trusted browser automation capabilities', () => {
  it('waits for a delayed table before freezing its rows, and fails a missing table', async () => {
    const result = await execute([
      step(
        'READ',
        [
          { op: 'navigate', url: '/' },
          { op: 'click', locator: locator('records') },
          { op: 'read', locator: locator('table'), read: 'table', as: 'rows' },
        ],
        [variable('ROWS', 'rows', [['Name'], ['Saved record']])],
      ),
    ]);
    expect(result.error).toBeUndefined();
    expect(result.run.cases[0].status).toBe('passed');
    const missing = await execute([
      step(
        'MISSING',
        [
          { op: 'navigate', url: '/' },
          { op: 'read', locator: locator('absent'), read: 'table', as: 'rows' },
        ],
        [variable('EMPTY', 'rows', [])],
      ),
    ]);
    expect(missing.run.cases[0].status).toBe('failed');
    expect(
      missing.observations.some(
        (record) => record.assertion_id === 'EMPTY' && record.status === 'passed',
      ),
    ).toBe(false);
  });

  it('shares storage between named tabs, isolates profiles, and persists data across actual process restart', async () => {
    const persistent: { directory: string; context: BrowserContext }[] = [];
    const launch = chromium.launchPersistentContext.bind(chromium);
    vi.spyOn(chromium, 'launchPersistentContext').mockImplementation(async (directory, options) => {
      const context = await launch(directory, options);
      persistent.push({ directory, context });
      return context;
    });
    const result = await execute([
      step(
        'FIRST',
        [
          { op: 'browser', command: 'open_profile', name: 'saved', url: '/' },
          { op: 'click', locator: locator('save') },
        ],
        [visibleText('SAVED', 'record', 'Saved record')],
      ),
      step(
        'SECOND',
        [{ op: 'browser', command: 'open_tab', name: 'second', url: '/' }],
        [
          visibleText('SHARED', 'record', 'Saved record'),
          visibleText('SESSION-ISOLATED', 'session', 'No session'),
        ],
      ),
      step(
        'ISOLATED',
        [{ op: 'browser', command: 'open_profile', name: 'isolated', url: '/' }],
        [visibleText('ISOLATED-EMPTY', 'record', 'No record')],
      ),
      step(
        'RESTART',
        [
          { op: 'browser', command: 'restart_profile', name: 'saved' },
          { op: 'browser', command: 'select_tab', name: 'main' },
        ],
        [
          visibleText('PERSISTED', 'record', 'Saved record'),
          visibleText('FRESH-SESSION', 'session', 'No session'),
        ],
      ),
      step(
        'RETURN',
        [{ op: 'browser', command: 'select_profile', name: 'isolated' }],
        [visibleText('STILL-ISOLATED', 'record', 'No record')],
      ),
    ]);
    expect(result.error).toBeUndefined();
    expect(result.run.cases[0].status).toBe('passed');
    expect(persistent).toHaveLength(3);
    expect(persistent[0].directory).toBe(persistent[2].directory);
    expect(persistent[0].context).not.toBe(persistent[2].context);
    for (const { directory, context } of persistent) {
      expect(context.browser()?.isConnected()).toBe(false);
      await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('captures dialog type/message and explicit acceptance or dismissal, including unexpected dialogs', async () => {
    const result = await execute([
      step(
        'DISMISS',
        [
          { op: 'navigate', url: '/' },
          {
            op: 'dialog',
            locator: locator('confirm'),
            response: 'dismiss',
            as: 'dismissed',
            timeout_ms: 100,
          },
        ],
        [
          variable('D-COUNT', 'dismissed.count', 1),
          variable('D-TYPE', 'dismissed.type', 'confirm'),
          variable('D-MESSAGE', 'dismissed.message', 'Clear all records?'),
          visibleText('D-STATE', 'result', 'Dismissed'),
        ],
      ),
      step(
        'ACCEPT',
        [
          {
            op: 'dialog',
            locator: locator('confirm'),
            response: 'accept',
            as: 'accepted',
            timeout_ms: 100,
          },
        ],
        [variable('A-COUNT', 'accepted.count', 1), visibleText('A-STATE', 'result', 'Accepted')],
      ),
      step(
        'NONE',
        [
          {
            op: 'dialog',
            locator: locator('quiet'),
            response: 'none',
            as: 'none',
            timeout_ms: 100,
          },
        ],
        [variable('N-COUNT', 'none.count', 0)],
      ),
    ]);
    expect(result.error).toBeUndefined();
    const unexpected = await execute([
      step(
        'UNEXPECTED',
        [
          { op: 'navigate', url: '/' },
          {
            op: 'dialog',
            locator: locator('confirm'),
            response: 'none',
            as: 'dialog',
            timeout_ms: 100,
          },
        ],
        [variable('NO-DIALOG', 'dialog.count', 0)],
      ),
    ]);
    expect(unexpected.run.cases[0].status).toBe('failed');
    expect(
      unexpected.observations.find((record) => record.assertion_id === 'NO-DIALOG'),
    ).toMatchObject({ expected: 0, actual: 1, status: 'failed' });
  });

  it('retains raw download bytes and exposes exact metadata without claiming invalid UTF-8 is valid text', async () => {
    const text = '\ufeffid,name\r\n1,café\r\n';
    const result = await execute([
      step(
        'DOWNLOAD',
        [
          { op: 'navigate', url: '/' },
          { op: 'download', locator: locator('export'), save_as: 'csv' },
          { op: 'download', locator: locator('invalid'), save_as: 'invalid' },
        ],
        [
          variable('NAME', 'csv.filename', 'records.csv'),
          variable('BYTES', 'csv.byte_length', Buffer.byteLength(text)),
          variable('UTF8', 'csv.utf8_valid', true),
          variable('BOM', 'csv.has_bom', true),
          variable('CRLF', 'csv.line_endings', 'crlf'),
          variable('END', 'csv.final_newline', true),
          variable('EXACT', 'csv.text', text),
          variable('INVALID', 'invalid.utf8_valid', false),
        ],
      ),
    ]);
    expect(result.error).toBeUndefined();
    expect(result.run.artifacts).toHaveLength(2);
    expect(await readFile(join(result.runDirectory, result.run.artifacts[0].path))).toEqual(
      Buffer.from(text),
    );
    expect(await readFile(join(result.runDirectory, result.run.artifacts[1].path))).toEqual(
      Buffer.from([255, 10]),
    );
  });

  it('proves bounded download absence while keeping a real empty-export defect failing with retained evidence', async () => {
    const result = await execute([
      step(
        'QUIET',
        [
          { op: 'navigate', url: '/' },
          { op: 'observe_download', locator: locator('quiet'), as: 'quiet', timeout_ms: 100 },
        ],
        [variable('QUIET-COUNT', 'quiet.count', 0), variable('CLICKED', 'quiet.activated', true)],
      ),
      step(
        'DISABLED',
        [{ op: 'observe_download', locator: locator('disabled'), as: 'disabled', timeout_ms: 100 }],
        [
          variable('DISABLED-COUNT', 'disabled.count', 0),
          variable('DISABLED-NOT-CLICKED', 'disabled.activated', false),
        ],
      ),
      step(
        'DEFECT',
        [{ op: 'observe_download', locator: locator('empty'), as: 'unexpected', timeout_ms: 100 }],
        [variable('NO-EMPTY-EXPORT', 'unexpected.count', 0)],
      ),
    ]);
    expect(result.run.cases[0].status).toBe('failed');
    expect(
      result.observations.find((record) => record.assertion_id === 'NO-EMPTY-EXPORT'),
    ).toMatchObject({ status: 'failed', expected: 0, actual: 1 });
    expect(result.run.artifacts).toHaveLength(1);
    expect(await readFile(join(result.runDirectory, result.run.artifacts[0].path))).toHaveLength(0);
  });

  it('reversibly denies storage before application startup without erasing saved data', async () => {
    const result = await execute([
      step(
        'SAVE',
        [
          { op: 'navigate', url: '/' },
          { op: 'click', locator: locator('save') },
        ],
        [visibleText('BEFORE', 'record', 'Saved record')],
      ),
      step(
        'DENIED',
        [{ op: 'storage', mode: 'denied' }],
        [visibleText('DENIED-STATE', 'record', 'Storage unavailable')],
      ),
      step(
        'RESTORED',
        [{ op: 'storage', mode: 'normal' }],
        [visibleText('AFTER', 'record', 'Saved record')],
      ),
    ]);
    expect(result.error, JSON.stringify(result.observations)).toBeUndefined();
    expect(result.run.cases[0].status).toBe('passed');
  });

  it('keeps new profiles inside the approved origins and cleans their files after failure', async () => {
    const persistent: string[] = [];
    const launch = chromium.launchPersistentContext.bind(chromium);
    vi.spyOn(chromium, 'launchPersistentContext').mockImplementation(async (directory, options) => {
      persistent.push(directory);
      return launch(directory, options);
    });
    const result = await execute([
      step('PROFILE', [{ op: 'browser', command: 'open_profile', name: 'temporary', url: '/' }]),
      step('FOREIGN', [
        { op: 'browser', command: 'open_tab', name: 'foreign', url: 'https://outside.invalid/' },
      ]),
    ]);
    expect(result.run.cases[0].status).toBe('failed');
    expect(persistent).toHaveLength(1);
    await expect(stat(persistent[0])).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
