import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { chromium, type Browser } from '@playwright/test';
import { ExecutionEngine, type ActionIssue, type AssertionIssue } from '../runtime/engine.js';
import { safePath } from '../files.js';
import { misplacedRoleSelector, misplacedRoleText } from '../locator-repair.js';
import type { Bindings, LocatorSpec, Observation, Plan, Run } from '../schema.js';
import { redactValue } from './security.js';

export type Rehearsal = {
  kind: 'authoring_diagnostics';
  plan_sha256: string;
  cases: Run['cases'];
  observations: Observation[];
  action_issues?: ActionIssue[];
  assertion_issues?: AssertionIssue[];
  role_text_probes?: number;
};

export type LocatorRepair = {
  case_id: string;
  step_id: string;
  before: LocatorSpec;
  after: LocatorSpec;
} & (
  { action_index: number; assertion_id?: never } | { assertion_id: string; action_index?: never }
);

type RehearsalFile = { path: string; content: string | Buffer };

/** Rehearsal does not create an approved package or a qualification run. It uses
 * the same trusted operations, then retains only sanitized authoring diagnostics. */
export async function rehearsePlan(
  root: string,
  plan: Plan,
  files: RehearsalFile[],
  bindings: Bindings = {},
  signal?: AbortSignal,
  locatorCheck?: 'probe' | 'diagnose',
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
    const assertionIssues: AssertionIssue[] = [];
    const engine = new ExecutionEngine(
      { projectRoot: root, packageDirectory, runDirectory, tests: [], socketPath: '' },
      plan,
      bindings,
      locatorCheck
        ? {
            action: (issue) => actionIssues.push(issue),
            assertion: (issue) => assertionIssues.push(issue),
            probeRoleText: locatorCheck === 'probe',
          }
        : undefined,
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
    const roleTextProbes = assertionIssues.filter(
      (issue) => issue.replacement_locator?.match === 'text',
    ).length;
    return {
      ...redactValue(
        {
          kind: 'authoring_diagnostics' as const,
          plan_sha256: createHash('sha256').update(JSON.stringify(plan)).digest('hex'),
          cases: updated.cases,
          observations: observations.map((o) => ({ ...o, artifacts: [] })),
          ...(actionIssues.length ? { action_issues: actionIssues } : {}),
          ...(assertionIssues.length ? { assertion_issues: assertionIssues } : {}),
        },
        secrets,
      ),
      ...(roleTextProbes ? { role_text_probes: roleTextProbes } : {}),
    };
  } finally {
    signal?.removeEventListener('abort', abort);
    await browser?.close().catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Apply proven locator fixes together, then check the complete revised suite once. */
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
  locatorRepairs?: LocatorRepair[];
  unreproducedFailures?: Observation[];
}> {
  const first = await rehearsePlan(root, plan, files, bindings, signal, 'probe');
  const actionFixes =
    first.action_issues?.filter(
      (issue) => issue.exact_match_available || issue.replacement_locator,
    ) ?? [];
  const assertionFixes = first.assertion_issues?.filter((issue) => issue.replacement_locator) ?? [];
  if (!actionFixes.length && !assertionFixes.length && !first.role_text_probes)
    return { plan, rehearsal: first };
  const corrected = structuredClone(plan);
  const stepFor = (issue: { case_id: string; step_id: string }) =>
    corrected.cases
      .find((item) => item.id === issue.case_id)
      ?.steps.find((step) => step.id === issue.step_id);
  const locatorRepairs: LocatorRepair[] = [];
  const provedReplacement = (before: LocatorSpec, evidence: LocatorSpec) => {
    const intended = misplacedRoleSelector(before) ?? misplacedRoleText(before);
    return isDeepStrictEqual(evidence, intended) ? intended : undefined;
  };
  for (const issue of actionFixes) {
    const action = stepFor(issue)?.actions[issue.action_index];
    if (!action || !('locator' in action)) continue;
    const before = action.locator;
    const after = issue.replacement_locator
      ? provedReplacement(before, issue.replacement_locator)
      : { ...before, exact: true };
    if (!after) continue;
    action.locator = after;
    locatorRepairs.push({
      case_id: issue.case_id,
      step_id: issue.step_id,
      action_index: issue.action_index,
      before,
      after,
    });
  }
  for (const issue of assertionFixes) {
    const assertion = stepFor(issue)?.assertions.find((item) => item.id === issue.assertion_id);
    if (!assertion?.locator || !issue.replacement_locator) continue;
    const before = assertion.locator;
    const after = provedReplacement(before, issue.replacement_locator);
    if (!after) continue;
    assertion.locator = after;
    locatorRepairs.push({
      case_id: issue.case_id,
      step_id: issue.step_id,
      assertion_id: issue.assertion_id,
      before,
      after,
    });
  }
  if (
    locatorRepairs.filter((repair) => repair.after.match === 'text').length <
    (first.role_text_probes ?? 0)
  )
    return {
      plan,
      rehearsal: first,
      rehearsalWarning:
        'The dry run could not retain enough evidence to apply every alert locator repair safely.',
    };
  if (!locatorRepairs.length) return { plan, rehearsal: first };
  onProgress?.(
    `Repaired ${locatorRepairs.length} confirmed locator ${locatorRepairs.length === 1 ? 'issue' : 'issues'}. Rerunning the dry run once.`,
  );
  try {
    const rehearsal = await rehearsePlan(root, corrected, files, bindings, signal, 'diagnose');
    const assertionKey = ({
      case_id,
      step_id,
      assertion_id,
    }: Pick<Observation, 'case_id' | 'step_id' | 'assertion_id'>) =>
      `${case_id}/${step_id}/${assertion_id}`;
    const unprobedAssertions = new Set(
      locatorRepairs
        .filter((repair) => repair.assertion_id && repair.after.match !== 'text')
        .map(assertionKey),
    );
    const differences = (result: Rehearsal) =>
      result.observations.filter(
        (entry) => entry.status === 'failed' && entry.assertion_id && entry.actual !== undefined,
      );
    const repeatedFailures = new Set(differences(rehearsal).map(assertionKey));
    // Rerunning unrelated cases must not hide an intermittent observed mismatch.
    const unreproducedFailures = differences(first).filter((entry) => {
      const key = assertionKey(entry);
      return !unprobedAssertions.has(key) && !repeatedFailures.has(key);
    });
    return {
      plan: corrected,
      rehearsal,
      rehearsalBeforeRepair: first,
      locatorRepairs,
      ...(unreproducedFailures.length ? { unreproducedFailures } : {}),
    };
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
