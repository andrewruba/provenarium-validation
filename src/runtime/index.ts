import { chromium } from '@playwright/test';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join, dirname, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { approvalSchema, planSchema, type Bindings, type Plan, type Run } from '../schema.js';
import { loadProject, requirementsApprovalErrors, saveProject } from '../project.js';
import { loadUrs } from '../urs.js';
import { prepareBindings, validateBindings } from '../credentials.js';
import { atomicJson, containedPath, digest, readRun, redactor, type WorkerContext } from './io.js';

const require = createRequire(import.meta.url);

export async function verifyApprovedPackage(
  projectRoot: string,
  selectedId?: string,
): Promise<{
  packageDirectory: string;
  plan: Plan;
  tests: string[];
  packageId: string;
  inputFiles: string[];
  approvalHash: string;
}> {
  const project = await loadProject(projectRoot);
  const packageId = selectedId ?? project.current_package;
  if (!packageId || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(packageId))
    throw new Error('Select an approved package with --package or approve a candidate first.');
  const packageDirectory = await containedPath(projectRoot, `packages/${packageId}`);
  const approvalBytes = await readFile(await containedPath(packageDirectory, 'approval.json'));
  const approval = approvalSchema.parse(JSON.parse(approvalBytes.toString('utf8')));
  if (approval.package_id !== packageId)
    throw new Error('The approval identity does not match the selected package.');
  for (const required of ['plan.json', 'urs.yaml', ...approval.tests]) {
    if (!Object.hasOwn(approval.files, required))
      throw new Error(`Required approved input is absent from the approval record: ${required}`);
  }
  for (const [path, expected] of Object.entries(approval.files)) {
    let bytes: Buffer;
    try {
      bytes = await readFile(await containedPath(packageDirectory, path));
    } catch {
      throw new Error(`Approved input is missing, unreadable, or outside the package: ${path}`);
    }
    if (digest(bytes) !== expected)
      throw new Error(`Approved input has changed: ${path}. Generate and approve a new package.`);
  }
  const plan = planSchema.parse(
    JSON.parse(await readFile(join(packageDirectory, 'plan.json'), 'utf8')),
  );
  if (approval.requirements_approval) {
    const urs = await loadUrs(await containedPath(packageDirectory, 'urs.yaml'));
    const errors = requirementsApprovalErrors(
      approval.requirements_approval,
      urs,
      plan,
      approval.files,
    );
    if (errors.length) throw new Error(errors.join('\n'));
  }
  for (const path of [...plan.fixtures, ...plan.references]) {
    if (!Object.hasOwn(approval.files, path))
      throw new Error(`Plan input is not frozen in the approval record: ${path}`);
  }
  const tests = await Promise.all(
    approval.tests.map((path) => containedPath(packageDirectory, path)),
  );
  return {
    packageDirectory,
    plan,
    tests,
    packageId,
    inputFiles: Object.keys(approval.files),
    approvalHash: digest(approvalBytes),
  };
}

export async function executePackage(
  projectRoot: string,
  selectedId?: string,
  options: { bindings?: Bindings; releaseLabel?: string; signal?: AbortSignal } = {},
): Promise<Run> {
  const root = resolve(projectRoot);
  const approved = await verifyApprovedPackage(root, selectedId);
  options.signal?.throwIfAborted();
  if (approved.tests.length) {
    const executable = chromium.executablePath();
    try {
      if (!(await stat(executable)).isFile()) throw new Error();
    } catch {
      throw new Error(
        'Chromium is not installed. Run the documented Playwright browser setup command before qualification execution.',
      );
    }
  }
  const bindings =
    options.bindings ??
    (approved.tests.length
      ? await prepareBindings(approved.plan.access, root, approved.plan.target.url, approved.plan)
      : {});
  if (approved.tests.length) validateBindings(approved.plan.access, bindings, approved.plan);
  const secretValues = Object.values(bindings).flatMap((value) =>
    [value.password, value.token].filter((item): item is string => Boolean(item)),
  );
  // Recheck after interactive preparation, which may have taken minutes.
  const rechecked = await verifyApprovedPackage(root, approved.packageId);
  if (rechecked.approvalHash !== approved.approvalHash)
    throw new Error(
      'The approval record changed during credential preparation. Execution has not started.',
    );
  // Every approved input is scanned, including normative documents, fixtures and compiled tests.
  for (const input of approved.inputFiles) {
    const bytes = await readFile(await containedPath(approved.packageDirectory, input));
    if (
      secretValues.some(
        (secret) =>
          secret &&
          (bytes.includes(Buffer.from(secret)) ||
            bytes.includes(Buffer.from(encodeURIComponent(secret)))),
      )
    ) {
      throw new Error(
        `Approved input ${input} contains a runtime credential. Replace it with a named binding.`,
      );
    }
  }
  const clean = redactor(secretValues);
  const id = `run-${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`;
  const runDirectory = await containedPath(root, `runs/${id}`);
  await mkdir(join(runDirectory, 'artifacts'), { recursive: true });
  const run: Run = {
    schema_version: 1,
    id,
    package_id: approved.packageId,
    started_at: new Date().toISOString(),
    complete: false,
    target_url: approved.plan.target.url,
    release_label: options.releaseLabel ? String(clean(options.releaseLabel)) : undefined,
    versions: {
      cli: require('../../package.json').version as string,
      playwright: require('@playwright/test/package.json').version as string,
      node: process.version,
    },
    accounts: Object.fromEntries(
      approved.plan.access
        .filter((actor) => actor.mode !== 'anonymous' && bindings[actor.id]?.username)
        .map((actor) => [
          actor.id,
          {
            username: String(clean(bindings[actor.id].username!)),
            role: actor.role,
            state: actor.state,
          },
        ]),
    ),
    cases: approved.plan.cases.map((testCase) => ({
      id: testCase.id,
      status: testCase.manual ? 'manual_pending' : 'not_run',
    })),
    artifacts: [],
  };
  await atomicJson(join(runDirectory, 'run.json'), run);
  await writeFile(join(runDirectory, 'observations.jsonl'), '', { mode: 0o600 });
  const project = await loadProject(root);
  await saveProject(root, { ...project, last_run: id });
  if (!approved.tests.length) {
    run.complete = true;
    run.ended_at = new Date().toISOString();
    await atomicJson(join(runDirectory, 'run.json'), run);
    return run;
  }
  const privateDirectory = await mkdtemp(join(tmpdir(), 'provenarium-run-'));
  await chmod(privateDirectory, 0o700);
  const socketPath = join(privateDirectory, 'credentials.sock');
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/bindings') {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(bindings));
  });
  let interrupted = false;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => resolve());
    });
    await chmod(socketPath, 0o600);
    const settings: WorkerContext = {
      projectRoot: root,
      packageDirectory: approved.packageDirectory,
      runDirectory,
      tests: approved.tests,
      socketPath,
    };
    const contextPath = join(privateDirectory, 'context.json');
    await atomicJson(contextPath, settings);
    let runtimeDirectory = dirname(fileURLToPath(import.meta.url));
    if (import.meta.url.endsWith('.ts'))
      runtimeDirectory = resolve(runtimeDirectory, '../../dist/runtime');
    const harnessPath = join(runtimeDirectory, 'harness.js');
    try {
      await stat(harnessPath);
    } catch {
      throw new Error(
        'The compiled execution runtime is missing. Build or reinstall the CLI before running.',
      );
    }
    const configPath = join(privateDirectory, 'playwright.config.cjs');
    const timeout = Math.min(
      30 * 60_000,
      Math.max(
        60_000,
        approved.plan.cases.reduce(
          (total, item) =>
            total +
            item.steps.reduce(
              (sum, step) =>
                sum + step.actions.length + step.assertions.length + step.evidence.length,
              0,
            ),
          0,
        ) * approved.plan.environment.timeout_ms,
      ),
    );
    await writeFile(
      configPath,
      `module.exports = ${JSON.stringify(
        {
          testDir: runtimeDirectory,
          testMatch: 'harness.js',
          workers: 1,
          retries: 0,
          fullyParallel: false,
          timeout,
          globalTimeout: timeout * Math.max(1, approved.plan.cases.length),
          forbidOnly: true,
          reporter: [[join(runtimeDirectory, 'reporter.js')]],
          outputDir: join(privateDirectory, 'browser-output'),
          use: {
            browserName: 'chromium',
            headless: true,
            trace: 'off',
            video: 'off',
            screenshot: 'off',
          },
        },
        null,
        2,
      )};\n`,
      { mode: 0o600 },
    );
    const env: NodeJS.ProcessEnv = { PROVENARIUM_RUN_CONTEXT: contextPath };
    for (const key of [
      'PATH',
      'HOME',
      'TMPDIR',
      'TMP',
      'TEMP',
      'SYSTEMROOT',
      'PLAYWRIGHT_BROWSERS_PATH',
      'DISPLAY',
      'XDG_RUNTIME_DIR',
    ])
      if (process.env[key]) env[key] = process.env[key];
    const child = spawn(
      process.execPath,
      [require.resolve('@playwright/test/cli'), 'test', '--config', configPath],
      { cwd: privateDirectory, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    // Never forward unfiltered Playwright/browser output: it can contain secret input values.
    child.stdout.resume();
    child.stderr.resume();
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      interrupted = true;
      child.kill('SIGINT');
      forceKill = setTimeout(() => child.kill('SIGKILL'), 5000);
      forceKill.unref();
    };
    options.signal?.addEventListener('abort', stop, { once: true });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    if (options.signal?.aborted) stop();
    let code: number | null;
    try {
      code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
    } finally {
      if (forceKill) clearTimeout(forceKill);
      options.signal?.removeEventListener('abort', stop);
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
    const result = await readRun(runDirectory);
    result.ended_at = new Date().toISOString();
    result.complete =
      !interrupted && code !== null && result.cases.every((item) => item.status !== 'not_run');
    if (
      code !== 0 &&
      result.cases.every((item) => item.status === 'passed' || item.status === 'manual_pending')
    )
      result.complete = false;
    await atomicJson(join(runDirectory, 'run.json'), result);
    return result;
  } catch {
    const result = await readRun(runDirectory);
    result.ended_at = new Date().toISOString();
    result.complete = false;
    await atomicJson(join(runDirectory, 'run.json'), result);
    throw new Error(`Execution could not complete. Retained run ${id} remains incomplete.`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(privateDirectory, { recursive: true, force: true });
  }
}
