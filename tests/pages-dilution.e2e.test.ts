import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
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
