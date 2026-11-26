import {
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { readFile, mkdir, stat, unlink, realpath } from 'node:fs/promises';
import { join, basename, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { observationSchema } from '../schema.js';
import type {
  Action,
  Assertion,
  Artifact,
  Bindings,
  LocatorSpec,
  Observation,
  Plan,
  TestCase,
} from '../schema.js';
import {
  appendObservation,
  containedPath,
  digest,
  redactor,
  secretFieldValues,
  updateRun,
  variableValue,
  type WorkerContext,
} from './io.js';
import { assertSessionLocation } from '../credentials.js';
import { boundedHttpRequest } from './http.js';
import { csvExpectedRowsError, parseCsv } from '../csv.js';

const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_OBSERVATION_CHARS = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
class ConcealedEvidenceError extends Error {}

export function locate(page: Page, locator: LocatorSpec): Locator {
  switch (locator.by) {
    case 'role':
      return page.getByRole(locator.role as Parameters<Page['getByRole']>[0], {
        name: locator.value,
        exact: locator.exact,
      });
    case 'label':
      return page.getByLabel(locator.value, { exact: locator.exact });
    case 'text':
      return page.getByText(locator.value, { exact: locator.exact });
    case 'testId':
      return page.getByTestId(locator.value);
    case 'css':
      return page.locator(locator.value);
  }
}

export function checkedUrl(value: string, plan: Plan): string {
  const url = new URL(value, plan.target.url);
  const allowed = new Set(plan.target.allowed_origins.map((origin) => new URL(origin).origin));
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !allowed.has(url.origin)
  ) {
    throw new Error('The operation targets an origin outside the approved scope.');
  }
  return url.toString();
}

export function compare(actual: unknown, assertion: Assertion): boolean {
  const expected = assertion.expected;
  switch (assertion.comparison) {
    case 'equals':
      return isDeepStrictEqual(actual, expected);
    case 'contains':
      return Array.isArray(actual)
        ? actual.some((item) => isDeepStrictEqual(item, expected))
        : typeof actual === 'string' && actual.includes(String(expected));
    case 'contains_any':
      return (
        typeof actual === 'string' &&
        Array.isArray(expected) &&
        expected.length >= 1 &&
        expected.length <= 20 &&
        expected.every(
          (value) => typeof value === 'string' && value.length >= 1 && value.length <= 200,
        ) &&
        expected.some((value) => actual.includes(value))
      );
    case 'csv_equals': {
      if (typeof actual !== 'string' || csvExpectedRowsError(expected)) return false;
      const rows = parseCsv(actual);
      return rows !== undefined && isDeepStrictEqual(rows, expected);
    }
    case 'not_contains':
      return Array.isArray(actual)
        ? !actual.some((item) => isDeepStrictEqual(item, expected))
        : typeof actual === 'string' && !actual.includes(String(expected));
    case 'numeric': {
      const number =
        typeof actual === 'number'
          ? actual
          : typeof actual === 'string' && actual.trim()
            ? Number(actual)
            : NaN;
      return (
        Number.isFinite(number) &&
        typeof expected === 'number' &&
        Math.abs(number - expected) <= (assertion.tolerance ?? 0)
      );
    }
    // Deliberately bounded substring wildcard, not a user-supplied regular expression.
    case 'matches': {
      if (typeof actual !== 'string' || typeof expected !== 'string') return false;
      if (!expected.includes('*')) return actual === expected;
      const pieces = expected.split('*');
      const prefix = pieces.shift()!,
        suffix = pieces.pop()!;
      if (
        !actual.startsWith(prefix) ||
        !actual.endsWith(suffix) ||
        actual.length < prefix.length + suffix.length
      )
        return false;
      let cursor = prefix.length;
      const limit = actual.length - suffix.length;
      for (const piece of pieces) {
        if (!piece) continue;
        const next = actual.indexOf(piece, cursor);
        if (next < 0 || next + piece.length > limit) return false;
        cursor = next + piece.length;
      }
      return cursor <= limit;
    }
    case 'present':
      return (
        actual !== undefined && actual !== null && actual !== false && actual !== '' && actual !== 0
      );
    case 'absent':
      return (
        actual === undefined || actual === null || actual === false || actual === '' || actual === 0
      );
  }
}

type Step = TestCase['steps'][number];
type DownloadValue = { path: string; text?: string; filename: string; artifact: Artifact };

export class ExecutionEngine {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private variables = new Map<string, unknown>();
  private masks: LocatorSpec[] = [];
  private secrets: string[];
  private clean: (value: unknown) => unknown;
  private caseId = '';
  private stepId = '';
  private runId = '';
  private packageId = '';
  private currentActor?: string;

  constructor(
    private readonly options: WorkerContext,
    readonly plan: Plan,
    private readonly bindings: Bindings,
  ) {
    this.secrets = Object.values(bindings).flatMap((binding) =>
      [binding.password, binding.token].filter((item): item is string => Boolean(item)),
    );
    this.clean = redactor(this.secrets);
  }

  async setBrowser(browser: Browser): Promise<void> {
    this.browser = browser;
    const run = await updateRun(this.options.runDirectory, (run) => {
      run.versions.browser = browser.version();
    });
    this.runId = run.id;
    this.packageId = run.package_id;
  }

  private async openContext(actor?: string): Promise<void> {
    if (!this.browser) throw new Error('The browser runner is unavailable.');
    await this.context?.close();
    const declaration = actor ? this.plan.access.find((entry) => entry.id === actor) : undefined;
    if (actor && !declaration) throw new Error(`Unknown access binding ${actor}.`);
    let storageState: string | undefined;
    if (declaration?.mode === 'session') {
      const state = this.bindings[declaration.id]?.storageState;
      if (!state) throw new Error(`Session prerequisite is missing for ${declaration.id}.`);
      storageState = assertSessionLocation(this.options.projectRoot, state);
      const full = await realpath(storageState);
      const auth = await realpath(join(this.options.projectRoot, '.provenarium', 'auth'));
      const rel = relative(auth, full);
      if (!rel || rel.startsWith('..'))
        throw new Error('Saved session escapes the authentication directory.');
    }
    this.context = await this.browser.newContext({
      locale: this.plan.environment.locale,
      timezoneId: this.plan.environment.timezone,
      viewport: this.plan.environment.viewport,
      storageState,
      serviceWorkers: 'block',
      acceptDownloads: true,
    });
    this.context.setDefaultTimeout(this.plan.environment.timeout_ms);
    this.context.setDefaultNavigationTimeout(this.plan.environment.timeout_ms);
    await this.context.route('**/*', async (route) => {
      try {
        checkedUrl(route.request().url(), this.plan);
        await route.continue();
      } catch {
        await route.abort('blockedbyclient');
      }
    });
    await this.context.routeWebSocket('**/*', (socket) => {
      try {
        const destination = new URL(socket.url());
        if (!['ws:', 'wss:'].includes(destination.protocol))
          throw new Error('Unsupported socket protocol.');
        destination.protocol = destination.protocol === 'wss:' ? 'https:' : 'http:';
        checkedUrl(destination.href, this.plan);
        socket.connectToServer();
      } catch {
        socket.close({ code: 1008, reason: 'WebSocket origin is outside the approved scope.' });
      }
    });
    this.page = await this.context.newPage();
    this.masks = [];
    this.currentActor = actor;
  }

  private binding(name: string): string {
    const [actor, field, ...rest] = name.split('.');
    if (rest.length || !['username', 'password', 'token'].includes(field))
      throw new Error('Unsupported secret binding reference.');
    if (!this.plan.access.some((item) => item.id === actor))
      throw new Error('Secret binding is not in the approved inventory.');
    const value = this.bindings[actor]?.[field as 'username' | 'password' | 'token'];
    if (!value) throw new Error(`Required credential binding ${name} is missing.`);
    return value;
  }

  private async refreshSessionSecrets(): Promise<void> {
    if (!this.context) return;
    const state = await this.context.storageState();
    const values = [
      ...state.cookies.map((cookie) => cookie.value),
      ...state.origins.flatMap((origin) => origin.localStorage.map((entry) => entry.value)),
    ];
    if (this.page && !this.page.isClosed()) {
      try {
        values.push(...(await this.page.evaluate(() => Object.values(sessionStorage))));
      } catch {
        /* about:blank or a navigation in progress */
      }
    }
    for (const value of values)
      if (value && !this.secrets.includes(value)) this.secrets.push(value);
    this.clean = redactor(this.secrets);
  }

  private async read(locator: LocatorSpec, kind: Assertion['read']): Promise<unknown> {
    const selected = locate(this.page!, locator);
    switch (kind) {
      case 'text':
        return selected.innerText();
      case 'value':
        return selected.inputValue();
      case 'count':
        return selected.count();
      case 'visible':
        return selected.isVisible();
      case 'enabled':
        return selected.isEnabled();
      case 'checked':
        return selected.isChecked();
      case 'table':
        return selected
          .locator('tr')
          .evaluateAll((rows) =>
            rows.map((row) =>
              Array.from(row.querySelectorAll('th,td')).map((cell) =>
                (cell.textContent ?? '').trim(),
              ),
            ),
          );
    }
  }

  private async observe(
    input: Omit<Observation, 'run_id' | 'package_id' | 'case_id' | 'step_id' | 'timestamp'>,
  ): Promise<void> {
    await this.refreshSessionSecrets();
    const actual = this.clean(input.actual);
    const expected = this.clean(input.expected);
    const concealed =
      Boolean(input.assertion_id) &&
      (!isDeepStrictEqual(actual, input.actual) || !isDeepStrictEqual(expected, input.expected));
    // Preserve trusted IDs, timestamps, status values and artifact references verbatim.
    // Short storage values can overlap this metadata without making it credential material.
    const observation = observationSchema.parse({
      run_id: this.runId,
      package_id: this.packageId,
      case_id: this.caseId,
      step_id: this.stepId,
      timestamp: new Date().toISOString(),
      ...input,
      actual,
      expected,
      status: concealed ? 'blocked' : input.status,
      message: concealed
        ? 'Credential material would conceal the asserted observation; this check cannot be established by retained evidence.'
        : this.clean(input.message),
    });
    const encoded = JSON.stringify(observation);
    if (encoded.length > MAX_OBSERVATION_CHARS)
      throw new Error('Required observation exceeds the supported evidence limit.');
    await appendObservation(this.options.runDirectory, observation);
    if (concealed)
      throw new ConcealedEvidenceError(
        'Credential material prevents retaining useful assertion evidence.',
      );
  }

  private async registerArtifact(path: string, id: string, kind: string): Promise<Artifact> {
    await this.refreshSessionSecrets();
    const info = await stat(path);
    if (info.size > MAX_ARTIFACT_BYTES) {
      await unlink(path);
      throw new Error('Required evidence exceeds the supported artifact limit.');
    }
    const data = await readFile(path);
    if (
      kind !== 'screenshot' &&
      this.secrets.some(
        (secret) =>
          data.includes(Buffer.from(secret)) ||
          data.includes(Buffer.from(encodeURIComponent(secret))),
      )
    ) {
      await unlink(path);
      throw new Error('Evidence contains a credential and cannot be retained.');
    }
    const artifact: Artifact = {
      id,
      path: relative(this.options.runDirectory, path).split('\\').join('/'),
      sha256: digest(data),
      kind,
      case_id: this.caseId,
      step_id: this.stepId,
    };
    await updateRun(this.options.runDirectory, (run) => {
      run.artifacts.push(artifact);
    });
    return artifact;
  }

  private async action(action: Action): Promise<void> {
    const page = this.page!;
    switch (action.op) {
      case 'navigate':
        await page.goto(checkedUrl(action.url, this.plan), { waitUntil: 'domcontentloaded' });
        break;
      case 'session':
        await this.openContext(action.actor);
        break;
      case 'fill':
        await locate(page, action.locator).fill(action.value);
        break;
      case 'fillSecret':
        this.masks.push(action.locator);
        await locate(page, action.locator).fill(this.binding(action.binding));
        break;
      case 'select':
        await locate(page, action.locator).selectOption(action.value);
        break;
      case 'click':
        await locate(page, action.locator).click();
        break;
      case 'upload': {
        if (!this.plan.fixtures.includes(action.path))
          throw new Error('Upload fixture is not listed in the approved plan.');
        await locate(page, action.locator).setInputFiles(
          await containedPath(this.options.packageDirectory, action.path),
        );
        break;
      }
      case 'read':
        this.variables.set(action.as, await this.read(action.locator, action.read));
        break;
      case 'download': {
        const [download] = await Promise.all([
          page.waitForEvent('download'),
          locate(page, action.locator).click(),
        ]);
        const path = join(
          this.options.runDirectory,
          'artifacts',
          `${this.caseId}-${this.stepId}-${action.save_as}.download`,
        );
        await download.saveAs(path);
        const artifact = await this.registerArtifact(path, action.save_as, 'download');
        const data = await readFile(path);
        const value: DownloadValue = {
          path: artifact.path,
          filename: basename(download.suggestedFilename()),
          artifact,
        };
        if (data.length <= MAX_RESPONSE_BYTES) value.text = data.toString('utf8');
        this.variables.set(action.save_as, value);
        break;
      }
      case 'request': {
        const result = await boundedHttpRequest(this.context!, checkedUrl(action.url, this.plan), {
          method: action.method,
          body: action.body,
          authToken: action.auth_binding ? this.binding(action.auth_binding) : undefined,
          timeoutMs: this.plan.environment.timeout_ms,
        });
        for (const secret of secretFieldValues(result.body))
          if (!this.secrets.includes(secret)) this.secrets.push(secret);
        this.clean = redactor(this.secrets);
        this.variables.set(action.as, result);
        break;
      }
    }
  }

  private async assertion(assertion: Assertion): Promise<void> {
    let actual: unknown;
    let matched = false;
    const getActual = async () =>
      assertion.locator
        ? this.read(assertion.locator, assertion.read)
        : variableValue(this.variables, assertion.variable!);
    try {
      if (assertion.locator) {
        await expect
          .poll(
            async () => {
              actual = await getActual();
              return compare(actual, assertion);
            },
            { timeout: this.plan.environment.timeout_ms },
          )
          .toBe(true);
        matched = true;
      } else {
        actual = await getActual();
        matched = compare(actual, assertion);
      }
    } catch {
      matched = false;
    }
    await this.observe({
      assertion_id: assertion.id,
      status: matched ? 'passed' : 'failed',
      expected: assertion.expected,
      actual,
      message: matched ? undefined : 'Observed result did not satisfy the approved assertion.',
      artifacts: [],
    });
    if (!matched) throw new Error(`Assertion ${assertion.id} failed.`);
  }

  private async evidence(step: Step): Promise<void> {
    for (const requested of step.evidence) {
      try {
        let artifact: Artifact | undefined;
        if (requested.kind === 'screenshot') {
          await this.refreshSessionSecrets();
          // Refuse screenshots when a known secret appears as ordinary rendered text.
          // Secret input controls are masked; arbitrary canvas/image exfiltration is outside supported capture.
          const rendered = await this.page!.locator('body').innerText();
          if (this.secrets.some((secret) => rendered.includes(secret)))
            throw new Error(
              'Rendered page contains credentials; screenshot evidence cannot be safely captured.',
            );
          const path = join(
            this.options.runDirectory,
            'artifacts',
            `${this.caseId}-${this.stepId}-${requested.id}.png`,
          );
          const masks = [
            this.page!.locator('input[type=password]'),
            ...this.masks.map((locator) => locate(this.page!, locator)),
          ];
          await this.page!.screenshot({
            path,
            fullPage: true,
            mask: masks,
            animations: 'disabled',
          });
          artifact = await this.registerArtifact(path, requested.id, 'screenshot');
        } else if (requested.kind === 'download') {
          const value = variableValue(
            this.variables,
            requested.variable ?? requested.id,
          ) as DownloadValue;
          if (!value?.artifact) throw new Error('Required download evidence was not produced.');
          artifact = value.artifact;
        } else {
          if (requested.variable) {
            await this.observe({
              status: 'passed',
              actual: variableValue(this.variables, requested.variable),
              artifacts: [],
            });
          } else if (!step.assertions.length)
            throw new Error(
              'Required observation evidence has neither an assertion nor a variable.',
            );
        }
        if (artifact) await this.observe({ status: 'passed', artifacts: [artifact] });
      } catch (error) {
        await this.observe({
          status: requested.required ? 'failed' : 'blocked',
          message: `Evidence ${requested.id} was not retained safely.`,
          artifacts: [],
        });
        if (requested.required) throw error;
      }
    }
  }

  async executeCase(caseId: string, frozenCase?: TestCase): Promise<void> {
    const testCase = this.plan.cases.find((item) => item.id === caseId);
    if (!testCase) throw new Error('Executable test references an unknown approved case.');
    if (frozenCase && !isDeepStrictEqual(frozenCase, testCase))
      throw new Error('Compiled test case differs from the approved plan.');
    this.caseId = caseId;
    this.stepId = testCase.steps[0]?.id ?? 'manual';
    this.variables.clear();
    if (testCase.manual) {
      await updateRun(this.options.runDirectory, (run) => {
        run.cases.find((item) => item.id === caseId)!.status = 'manual_pending';
      });
      return;
    }
    let status: 'passed' | 'failed' | 'blocked' = 'blocked';
    try {
      await mkdir(join(this.options.runDirectory, 'artifacts'), { recursive: true });
      await this.openContext(testCase.actor);
      status = 'failed';
      for (const step of testCase.steps) {
        this.stepId = step.id;
        let stepFailure: unknown;
        try {
          for (const action of step.actions) await this.action(action);
          for (const assertion of step.assertions) await this.assertion(assertion);
        } catch (error) {
          stepFailure = error;
        }
        // Capture declared evidence even when the assertion fails, retaining the original failure.
        try {
          await this.evidence(step);
        } catch (error) {
          stepFailure ??= error;
        }
        if (stepFailure) throw stepFailure;
        await this.observe({ status: 'passed', artifacts: [] });
      }
      status = 'passed';
      await updateRun(this.options.runDirectory, (run) => {
        run.cases.find((item) => item.id === caseId)!.status = 'passed';
      });
    } catch (error) {
      if (error instanceof ConcealedEvidenceError) status = 'blocked';
      const message =
        error instanceof ConcealedEvidenceError
          ? 'Credential material would conceal the asserted behavior; this case remains blocked.'
          : status === 'blocked'
            ? 'A required session or browser prerequisite was unavailable.'
            : 'The approved procedure or required evidence failed; inspect retained observations.';
      await this.observe({ status, message, artifacts: [] });
      await updateRun(this.options.runDirectory, (run) => {
        const entry = run.cases.find((item) => item.id === caseId)!;
        entry.status = status;
        entry.message = message;
      });
      throw new Error(`${caseId}: ${message}`);
    } finally {
      await this.context?.close().catch(() => {});
      this.context = undefined;
      this.page = undefined;
    }
  }
}
