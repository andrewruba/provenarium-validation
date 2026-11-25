import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { preparePagesDilution, variantUrl } from '../scripts/prepare-pages-dilution.mjs';
import { readVersion } from '../scripts/validate-pages-dilution.mjs';
import { planSchema } from '../src/schema.js';
import { validatePlan } from '../src/compiler.js';
import { loadUrs } from '../src/urs.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'pages dilution preparation '));
  roots.push(root);
  return root;
}

it('preserves Pages project paths and rejects credentials or ambiguous state', () => {
  expect(variantUrl('https://example.github.io/project/correct')).toBe(
    'https://example.github.io/project/correct/',
  );
  expect(variantUrl('http://127.0.0.1:4176/nested/faulty/')).toBe(
    'http://127.0.0.1:4176/nested/faulty/',
  );
  for (const url of [
    'https://user:secret@example.com/correct/',
    'http://example.com/correct/',
    'http://localhost.example.com/correct/',
    'file:///correct/',
    'https://example.com/correct/?workspace=someone-else',
    'https://example.com/correct/#records',
    'https://example.com/correct%2Ffaulty/',
    ' https://example.com/correct/',
    'not a URL',
  ])
    expect(() => variantUrl(url), url).toThrow();
});

it('prepares browser-only procedures for a subpath without changing their expectations', async () => {
  const root = await directory();
  const originalBytes = await readFile('examples/dilution-pages-validation/plan.json');
  const source = JSON.parse(originalBytes.toString('utf8'));
  const prepared = await preparePagesDilution({
    url: 'https://example.github.io/project/correct/',
    project: join(root, 'validation with spaces'),
  });
  expect(prepared.target.target_url).toBe(
    `https://example.github.io/project/correct/?workspace=${prepared.target.workspace}`,
  );
  const plan = planSchema.parse(prepared.plan);
  expect(validatePlan(plan, await loadUrs(join(prepared.project, 'urs.yaml')))).toEqual([]);
  for (const [ci, item] of prepared.plan.cases.entries()) {
    for (const [si, step] of item.steps.entries()) {
      expect(step.assertions).toEqual(source.cases[ci].steps[si].assertions);
      for (const action of step.actions) {
        expect(action.op).not.toBe('request');
        if (action.op === 'navigate') {
          const url = new URL(action.url);
          expect(url.pathname).toMatch(/^\/project\/correct\/(?:version\.json)?$/);
          if (!url.pathname.endsWith('version.json'))
            expect(url.searchParams.get('workspace')).toBe(prepared.target.workspace);
        }
      }
    }
  }
  expect(await readFile('examples/dilution-pages-validation/plan.json')).toEqual(originalBytes);
  expect(await readdir(prepared.project)).not.toContain('packages');
});

it('allocates independent workspaces and refuses to overwrite retained projects', async () => {
  const root = await directory();
  const url = 'https://example.github.io/project/correct/';
  const first = await preparePagesDilution({ url, project: join(root, 'first') });
  await writeFile(join(first.project, 'sentinel'), 'keep');
  await expect(preparePagesDilution({ url, project: first.project })).rejects.toThrow();
  expect(await readFile(join(first.project, 'sentinel'), 'utf8')).toBe('keep');
  const second = await preparePagesDilution({ url, project: join(root, 'second') });
  expect(second.target.workspace).not.toBe(first.target.workspace);
  await expect(
    preparePagesDilution({ url, project: join(root, 'bad'), workspace: '../other' }),
  ).rejects.toThrow(/Workspace/);
});

it('checks mode and commit metadata without following redirects', async () => {
  const url = 'https://example.github.io/project/correct/';
  const commit = 'a'.repeat(40);
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(JSON.stringify({ application: 'Dilution Bench', mode: 'correct', commit })),
    );
  expect(await readVersion(url, { mode: 'correct', commit })).toMatchObject({ commit });
  expect(String(fetch.mock.calls[0][0])).toBe(`${url}version.json`);
  expect(fetch.mock.calls[0][1]?.redirect).toBe('manual');
  fetch.mockResolvedValue(
    new Response(JSON.stringify({ application: 'Dilution Bench', mode: 'faulty', commit })),
  );
  await expect(readVersion(url, { mode: 'correct' })).rejects.toThrow(/correct/);
  fetch.mockResolvedValue(
    new Response(
      JSON.stringify({ application: 'Dilution Bench', mode: 'correct', commit: 'b'.repeat(40) }),
    ),
  );
  await expect(readVersion(url, { mode: 'correct', commit })).rejects.toThrow(/commit/);
  for (const metadata of [
    { mode: 'correct' },
    { application: 'Another app', mode: 'correct', commit },
    { application: 'Dilution Bench', mode: 'correct', commit: 'short' },
    null,
  ]) {
    fetch.mockResolvedValue(new Response(JSON.stringify(metadata)));
    await expect(readVersion(url, { mode: 'correct' })).rejects.toThrow(/identify Dilution Bench/);
  }
});
