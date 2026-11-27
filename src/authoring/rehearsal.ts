import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, type Browser } from '@playwright/test';
import { ExecutionEngine, type ActionIssue } from '../runtime/engine.js';
import { safePath } from '../files.js';
import type { Bindings, Observation, Plan, Run } from '../schema.js';
import { redactValue } from './security.js';

export type Rehearsal = {
  kind: 'authoring_diagnostics';
  plan_sha256: string;
  cases: Run['cases'];
  observations: Observation[];
  action_issues?: ActionIssue[];
};

type RehearsalFile = { path: string; content: string | Buffer };

/** Rehearsal does not create an approved package or a qualification run. It uses
 * the same trusted operations, then retains only sanitized authoring diagnostics. */
export async function rehearsePlan(
  root: string,
  plan: Plan,
  files: RehearsalFile[],
  bindings: Bindings = {},
  signal?: AbortSignal,
  diagnoseActions = false,
): Promise<Rehearsal> {
  signal?.throwIfAborted();
  const temporary = await mkdtemp(path.join(tmpdir(), 'provenarium-authoring-'));
  const packageDirectory = path.join(temporary, 'candidate');
  const runDirectory = path.join(temporary, 'diagnostics');
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
  let browser: Browser | undefined;
  const abort = () => {
    void browser?.close().catch(() => undefined);
  };
  try {
    await mkdir(packageDirectory);
    await mkdir(runDirectory);
    browser = await chromium.launch({ headless: true });
    signal?.addEventListener('abort', abort, { once: true });
    signal?.throwIfAborted();
    for (const file of files) {
      const filename = await safePath(packageDirectory, file.path);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, file.content, { mode: 0o600 });
    }
    await writeFile(path.join(runDirectory, 'run.json'), JSON.stringify(run), { mode: 0o600 });
    const actionIssues: ActionIssue[] = [];
    const engine = new ExecutionEngine(
      { projectRoot: root, packageDirectory, runDirectory, tests: [], socketPath: '' },
      plan,
      bindings,
      diagnoseActions ? (issue) => actionIssues.push(issue) : undefined,
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
    signal?.throwIfAborted();
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
        ...(actionIssues.length ? { action_issues: actionIssues } : {}),
      },
      secrets,
    );
  } finally {
    signal?.removeEventListener('abort', abort);
    await browser?.close().catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Keep expected outcomes fixed. Only tighten a selector when the browser proved
 * that its exact name was unique and the broader selector was ambiguous. */
export async function checkPlanInBrowser(
  root: string,
  plan: Plan,
  files: RehearsalFile[],
  bindings: Bindings = {},
  signal?: AbortSignal,
  onProgress?: (message: string) => void,
): Promise<{
  plan: Plan;
  rehearsal: Rehearsal;
  rehearsalBeforeRepair?: Rehearsal;
  rehearsalWarning?: string;
}> {
  const first = await rehearsePlan(root, plan, files, bindings, signal, true);
  const issue = first.action_issues?.find((item) => item.exact_match_available);
  if (!issue) return { plan, rehearsal: first };

  const corrected = structuredClone(plan);
  const action = corrected.cases
    .find((item) => item.id === issue.case_id)
    ?.steps.find((step) => step.id === issue.step_id)?.actions[issue.action_index];
  if (!action || !('locator' in action)) return { plan, rehearsal: first };
  action.locator.exact = true;
  onProgress?.(
    `Retrying the browser check after narrowing the selector in ${issue.case_id}/${issue.step_id}.`,
  );
  try {
    const rehearsal = await rehearsePlan(root, corrected, files, bindings, signal, true);
    return { plan: corrected, rehearsal, rehearsalBeforeRepair: first };
  } catch {
    signal?.throwIfAborted();
    return {
      plan,
      rehearsal: first,
      rehearsalWarning:
        'The browser retry could not finish. The first dry run and original tests are available for review.',
    };
  }
}
