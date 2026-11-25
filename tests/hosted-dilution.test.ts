import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareDilution, serviceOrigin } from '../scripts/prepare-dilution.mjs';
import { waitForHealth } from '../scripts/validate-hosted-dilution.mjs';
import { planSchema } from '../src/schema.js';
import { validatePlan } from '../src/compiler.js';
import { loadUrs } from '../src/urs.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'hosted dilution preparation '));
  roots.push(root);
  return root;
}

describe('hosted dilution preparation', () => {
  it('accepts service origins and refuses credentials, insecure remote hosts, or ambiguous routes', () => {
    expect(serviceOrigin('https://demo.onrender.com/')).toBe('https://demo.onrender.com');
    expect(serviceOrigin('http://127.0.0.1:4174')).toBe('http://127.0.0.1:4174');
    expect(serviceOrigin('http://[::1]:4174/')).toBe('http://[::1]:4174');
    for (const url of [
      'https://user:password@demo.onrender.com',
      'http://demo.onrender.com',
      'http://127.0.0.1.example.com',
      'file:///tmp/app',
      'https://demo.onrender.com/w/existing/',
      'https://demo.onrender.com?key=secret',
      'https://demo.onrender.com#secret',
      ' https://demo.onrender.com',
      'not a URL',
    ])
      expect(() => serviceOrigin(url), url).toThrow();
  });

  it('changes only the deployment targets and preserves independent expected results', async () => {
    const root = await directory();
    const sourceBytes = await readFile('examples/dilution-validation/plan.json');
    const source = JSON.parse(sourceBytes.toString('utf8'));
    const prepared = await prepareDilution({
      url: 'https://demo.onrender.com',
      project: join(root, 'new project with spaces'),
    });
    expect(prepared.target.workspace).toMatch(/^[A-Za-z0-9_-]{8,80}$/);
    const prefix = `/w/${prepared.target.workspace}`;
    const rewritten = JSON.parse(await readFile(join(prepared.project, 'plan.json'), 'utf8'));
    expect(rewritten.target).toEqual({
      url: `https://demo.onrender.com${prefix}/`,
      allowed_origins: ['https://demo.onrender.com'],
    });
    const restored = structuredClone(rewritten);
    restored.target = source.target;
    for (const item of restored.cases)
      for (const step of item.steps)
        for (const action of step.actions) {
          if (!['navigate', 'request'].includes(action.op)) continue;
          expect(action.url.startsWith(`${prefix}/`)).toBe(true);
          action.url = action.url.slice(prefix.length);
        }
    expect(restored).toEqual(source);
    expect(await readFile('examples/dilution-validation/plan.json')).toEqual(sourceBytes);
    const urs = await loadUrs(join(prepared.project, 'urs.yaml'));
    expect(validatePlan(planSchema.parse(rewritten), urs)).toEqual([]);
    expect(await readdir(prepared.project)).toEqual(
      expect.arrayContaining(['plan.json', 'urs.yaml', 'target.json', 'references']),
    );
    expect(await readdir(prepared.project)).not.toContain('packages');
    expect(await readFile(join(prepared.project, 'references/calculation-examples.csv'))).toEqual(
      await readFile('examples/dilution-validation/references/calculation-examples.csv'),
    );
  });

  it('never overwrites an existing project and allocates independent default workspaces', async () => {
    const root = await directory();
    const first = await prepareDilution({
      url: 'https://demo.onrender.com',
      project: join(root, 'first'),
    });
    await writeFile(join(first.project, 'sentinel.txt'), 'retained evidence');
    await expect(
      prepareDilution({ url: 'https://demo.onrender.com', project: first.project }),
    ).rejects.toThrow();
    expect(await readFile(join(first.project, 'sentinel.txt'), 'utf8')).toBe('retained evidence');
    const second = await prepareDilution({
      url: 'https://demo.onrender.com',
      project: join(root, 'second'),
    });
    expect(second.target.workspace).not.toBe(first.target.workspace);
    await expect(
      prepareDilution({
        url: 'https://demo.onrender.com',
        project: join(root, 'invalid'),
        workspace: '../existing',
      }),
    ).rejects.toThrow(/Workspace/);
    expect(await readdir(root)).toEqual(['first', 'second']);
  });

  it('requires a scoped health response and the requested release without following redirects', async () => {
    const target = {
      target_url: 'https://demo.onrender.com/w/test-workspace/',
      workspace: 'test-workspace',
    };
    const response = (mode: string) =>
      new Response(
        JSON.stringify({
          status: 'ok',
          application: 'Dilution Bench',
          mode,
          commit: 'a'.repeat(40),
        }),
        {
          headers: {
            'X-Dilution-Workspace': 'test-workspace',
            'X-Dilution-Generation': 'generation-12345',
          },
        },
      );
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response('correct'));
    expect(
      await waitForHealth(target, { mode: 'correct', commit: 'a'.repeat(40), timeoutMs: 50 }),
    ).toMatchObject({ generation: 'generation-12345' });
    expect(fetchSpy.mock.calls[0][1]?.redirect).toBe('manual');
    fetchSpy.mockImplementation(async () => response('faulty'));
    await expect(waitForHealth(target, { mode: 'correct', timeoutMs: 1 })).rejects.toThrow(
      /correct application mode/,
    );
    fetchSpy.mockImplementation(async () => new Response('{}'));
    await expect(waitForHealth(target, { timeoutMs: 1 })).rejects.toThrow(/healthy Dilution Bench/);
  });
});
