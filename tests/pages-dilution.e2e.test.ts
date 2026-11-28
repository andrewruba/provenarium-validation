import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';
import { buildPages } from '../scripts/build-pages.mjs';
import { validatePagesDilution } from '../scripts/validate-pages-dilution.mjs';

let root: string;
let server: Server;
let base: string;
const commit = 'a'.repeat(40);
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'static Pages fixture '));
  const site = join(root, 'static site');
  await buildPages({ output: site, commit });
  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      if (!pathname.startsWith('/a-repository/')) throw new Error('Outside project');
      let file = resolve(site, pathname.slice('/a-repository/'.length));
      if (file !== site && !file.startsWith(site + sep)) throw new Error('Outside site');
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      const type = file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : file.endsWith('.json')
            ? 'application/json'
            : 'text/html';
      response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      response.end(await readFile(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  base = `http://127.0.0.1:${address.port}/a-repository`;
});
afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (root) await rm(root, { recursive: true, force: true });
});

it.each(['correct', 'faulty'])(
  'shows unreadable storage as unavailable in the %s build',
  async (mode) => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(5000);
      await page.goto(`${base}/${mode}/?workspace=unreadable-storage#records`);
      const empty = page.locator('#empty-records');
      const count = page.locator('#record-count');
      expect(await empty.isVisible()).toBe(true);
      expect(await count.innerText()).toBe('0 saved preparations');

      const session = await page.context().newCDPSession(page);
      await session.send('Page.enable');
      const { identifier } = await session.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `Object.defineProperty(window, 'localStorage', {
          configurable: true,
          get() { throw new DOMException('Storage denied', 'SecurityError'); }
        });`,
      });
      await page.reload();
      expect(await page.getByRole('alert').innerText()).toContain('Browser storage is unavailable');
      expect(await empty.isVisible()).toBe(false);
      expect(await count.innerText()).toBe('Saved preparations unavailable');

      await session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
      await page.reload();
      expect(await empty.isVisible()).toBe(true);
      expect(await count.innerText()).toBe('0 saved preparations');
    } finally {
      await browser.close();
    }
  },
);

it('saves and reloads valid finite dilutions above the old numeric cap', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(`${base}/correct/?workspace=large-finite-inputs`);
    const sampleId = page.locator('#sampleId');
    const stock = page.locator('#stockConcentration');
    const target = page.locator('#targetConcentration');
    const finalVolume = page.locator('#finalVolume');
    const save = page.getByRole('button', { name: 'Calculate and save' });
    const result = page.locator('#results');

    await sampleId.fill('Large-1');
    await stock.fill(' +1e10 ');
    await target.fill('5E+9');
    await finalVolume.fill('2');
    await save.click();
    expect(await result.isVisible()).toBe(true);
    expect(await result.getByTestId('result-sample-id').innerText()).toBe('Large-1');
    expect(await result.getByTestId('result-stock-volume').innerText()).toBe('1.000');
    expect(await result.getByTestId('result-diluent-volume').innerText()).toBe('1.000');

    await sampleId.fill('Large-2');
    await stock.fill('2');
    await target.fill('1');
    await finalVolume.fill('4e21');
    await save.click();
    expect(await result.isVisible()).toBe(true);
    expect(await result.getByTestId('result-sample-id').innerText()).toBe('Large-2');
    expect(await result.getByTestId('result-stock-volume').innerText()).toBe(
      '2000000000000000000000.000',
    );
    expect(await result.getByTestId('result-diluent-volume').innerText()).toBe(
      '2000000000000000000000.000',
    );

    await sampleId.fill('Non-finite');
    await stock.fill('1e309');
    await save.click();
    expect(await result.isVisible()).toBe(false);
    expect(await page.getByRole('alert').innerText()).toBe(
      'Stock concentration must be a finite number.',
    );

    await page.getByRole('link', { name: 'Saved preparations' }).click();
    await page.reload();
    expect(await page.locator('#record-count').innerText()).toBe('2 saved preparations');
    expect(await page.getByTestId('record-Large-1').locator('td').allTextContents()).toEqual([
      'Large-1',
      '10000000000.000',
      '5000000000.000',
      '2.000',
      '1.000',
      '1.000',
    ]);
    expect(await page.getByTestId('record-Large-2').locator('td').allTextContents()).toEqual([
      'Large-2',
      '2.000',
      '1.000',
      '4000000000000000000000.000',
      '2000000000000000000000.000',
      '2000000000000000000000.000',
    ]);
  } finally {
    await browser.close();
  }
});

it('runs both static qualification fixtures under a repository subpath', async () => {
  const comparison = await validatePagesDilution({
    correctUrl: `${base}/correct/`,
    faultyUrl: `${base}/faulty/`,
    output: join(root, 'evidence'),
    commit,
    log: () => {},
  });
  expect(comparison.complete).toBe(true);
  expect(comparison.results.faulty.passed).toBe(7);
  expect(comparison.results.faulty.failed).toHaveLength(4);
  expect(comparison.results.correct.passed).toBe(11);
  expect(comparison.results.correct.failed).toEqual([]);
  expect(comparison.results.correct.package_id).not.toBe(comparison.results.faulty.package_id);
  expect(comparison.results.correct.protocol_source_sha256).toBe(
    comparison.results.faulty.protocol_source_sha256,
  );
  for (const mode of ['faulty', 'correct']) {
    const result = comparison.results[mode];
    expect(result.target_url).toContain(`/a-repository/${mode}/?workspace=`);
    expect(result.deployed_commit).toBe(commit);
    expect(await readFile(result.report, 'utf8')).toContain('URS-CALC-001');
    expect(await readFile(result.traceability, 'utf8')).toContain('URS-CALC-001');
  }
}, 240000);
