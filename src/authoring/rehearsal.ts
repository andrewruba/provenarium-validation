import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { ExecutionEngine } from '../runtime/engine.js';
import { safePath } from '../files.js';
import type { Bindings, Observation, Plan, Run } from '../schema.js';
import { redactValue } from './security.js';

export type Rehearsal = {
  kind: 'authoring_diagnostics';
  plan_sha256: string;
  cases: Run['cases'];
  observations: Observation[];
};

/** Rehearsal does not create an approved package or a qualification run. It uses
 * the same trusted operations, then retains only sanitized authoring diagnostics. */
export async function rehearsePlan(
  root: string,
  plan: Plan,
  fixtures: { path: string; content: string }[],
  bindings: Bindings = {},
  signal?: AbortSignal,
): Promise<Rehearsal> {
  const temporary = await mkdtemp(path.join(tmpdir(), 'provenarium-authoring-'));
  const packageDirectory = path.join(temporary, 'candidate');
  const runDirectory = path.join(temporary, 'diagnostics');
  await mkdir(packageDirectory);
  await mkdir(runDirectory);
  const id = 'rehearsal-' + Date.now();
  const run: Run = {
    schema_version: 1,
    id,
    package_id: plan.id,
    started_at: new Date().toISOString(),
    complete: false,
    target_url: plan.target.url,
    versions: { purpose: 'authoring diagnostics' },
    accounts: {},
    cases: plan.cases.map((c) => ({ id: c.id, status: c.manual ? 'manual_pending' : 'not_run' })),
    artifacts: [],
  };
  const browser = await chromium.launch({ headless: true });
  const abort = () => {
    void browser.close();
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    for (const fixture of fixtures) {
      const filename = await safePath(packageDirectory, fixture.path);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, fixture.content, { mode: 0o600 });
    }
    await writeFile(path.join(runDirectory, 'run.json'), JSON.stringify(run), { mode: 0o600 });
    const engine = new ExecutionEngine(
      { projectRoot: root, packageDirectory, runDirectory, tests: [], socketPath: '' },
      plan,
      bindings,
    );
    await engine.setBrowser(browser);
    for (const item of plan.cases) {
      signal?.throwIfAborted();
      try {
        await engine.executeCase(item.id);
      } catch {
        /* The engine retained the failed diagnostic; do not retry it. */
      }
    }
    const updated = JSON.parse(await readFile(path.join(runDirectory, 'run.json'), 'utf8')) as Run;
    let observations: Observation[] = [];
    try {
      observations = (await readFile(path.join(runDirectory, 'observations.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((row) => JSON.parse(row) as Observation);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const secrets = Object.values(bindings).flatMap((b) =>
      [b.password, b.token].filter((v): v is string => Boolean(v)),
    );
    return redactValue(
      {
        kind: 'authoring_diagnostics' as const,
        plan_sha256: createHash('sha256').update(JSON.stringify(plan)).digest('hex'),
        cases: updated.cases,
        observations: observations.map((o) => ({ ...o, artifacts: [] })),
      },
      secrets,
    );
  } finally {
    signal?.removeEventListener('abort', abort);
    await browser.close().catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  }
}
