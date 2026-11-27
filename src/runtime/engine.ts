import {
  chromium,
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Download,
  type Dialog,
  type CDPSession,
} from '@playwright/test';
import { readFile, mkdir, stat, unlink, realpath, mkdtemp, rm } from 'node:fs/promises';
import { join, basename, relative } from 'node:path';
import { tmpdir } from 'node:os';
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
import { misplacedRoleSelector } from '../locator-repair.js';

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
export type ActionIssue = {
  case_id: string;
  step_id: string;
  action_index: number;
  operation: Action['op'];
  reason: 'locator_missing' | 'locator_ambiguous' | 'action_failed';
  exact_match_available?: true;
  replacement_locator?: LocatorSpec;
};
export type AssertionIssue = {
  case_id: string;
  step_id: string;
  assertion_id: string;
  reason: 'locator_missing' | 'locator_ambiguous' | 'read_failed';
  replacement_locator?: LocatorSpec;
};
type DownloadValue = {
  path: string;
  text?: string;
  filename: string;
  artifact: Artifact;
  byte_length: number;
  utf8_valid: boolean;
  has_bom: boolean;
  line_endings: 'crlf' | 'lf' | 'cr' | 'mixed' | 'none';
  final_newline: boolean;
};
type RuntimeTab = {
  page: Page;
  masks: LocatorSpec[];
  storage?: { session: CDPSession; identifier: string };
};
type RuntimeProfile = {
  context: BrowserContext;
  directory?: string;
  tabs: Map<string, RuntimeTab>;
  activeTab: string;
};

// Fixed instrumentation only. No author-provided expression or script is evaluated.
const DENY_STORAGE = `for (const name of ['localStorage', 'sessionStorage']) {
  Object.defineProperty(window, name, { configurable: true, get() {
    throw new DOMException('Storage access is denied by the qualification browser.', 'SecurityError');
  }});
}`;

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
  private profiles = new Map<string, RuntimeProfile>();
  private activeProfile = 'main';
  private closingProfiles?: Promise<void>;

  constructor(
    private readonly options: WorkerContext,
    readonly plan: Plan,
    private readonly bindings: Bindings,
    private readonly onActionIssue?: (issue: ActionIssue) => void,
    private readonly onAssertionIssue?: (issue: AssertionIssue) => void,
  ) {
    this.secrets = Object.values(bindings).flatMap((binding) =>
      [binding.password, binding.token].filter((item): item is string => Boolean(item)),
    );
    this.clean = redactor(this.secrets);
  }

  /** The caller has confirmed the original accessible-name lookup found nothing. */
  private async proveMisplacedRoleSelector(page: Page, locator: LocatorSpec) {
    const replacement = misplacedRoleSelector(locator);
    if (!replacement || !locator.role) return;
    const target = locate(page, replacement);
    if ((await target.count()) !== 1) return;
    if ((await target.and(page.getByRole(locator.role)).count()) !== 1) return;
    if (await target.isVisible()) return replacement;
  }

  /** Diagnose the failing step without retaining Playwright errors or page contents. */
  private async diagnoseAction(
    action: Action,
    index: number,
    error: unknown,
  ): Promise<ActionIssue> {
    const issue: ActionIssue = {
      case_id: this.caseId,
      step_id: this.stepId,
      action_index: index,
      operation: action.op,
      reason: 'action_failed',
    };
    const page = this.page;
    if (!page || page.isClosed() || !('locator' in action)) return issue;
    try {
      const count = await locate(page, action.locator).count();
      if (count === 0) {
        issue.reason = 'locator_missing';
        const replacement = await this.proveMisplacedRoleSelector(page, action.locator);
        if (replacement) issue.replacement_locator = replacement;
      }
      if (count > 1) {
        issue.reason = 'locator_ambiguous';
        if (
          error instanceof Error &&
          error.message.includes('strict mode violation') &&
          action.locator.exact === false &&
          ['role', 'label', 'text'].includes(action.locator.by)
        ) {
          const exact = locate(page, { ...action.locator, exact: true });
          if ((await exact.count()) === 1 && (await exact.isVisible()))
            issue.exact_match_available = true;
        }
      }
    } catch {
      // A disconnected browser or invalid selector can prevent finer diagnosis.
    }
    return issue;
  }

  private async diagnoseAssertion(
    assertion: Assertion,
    actual: unknown,
  ): Promise<AssertionIssue | undefined> {
    const { locator, read } = assertion;
    const page = this.page;
    if (!locator || !page || page.isClosed()) return;
    // A successful read that disagreed with the expected result is evidence
    // about the app. False visibility and zero count can indicate no locator.
    const couldBeMissing =
      (read === 'visible' && actual === false) || (read === 'count' && actual === 0);
    if (actual !== undefined && !couldBeMissing) return;
    const issue: AssertionIssue = {
      case_id: this.caseId,
      step_id: this.stepId,
      assertion_id: assertion.id,
      reason: 'read_failed',
    };
    try {
      const count = await locate(page, locator).count();
      if (count === 0) {
        issue.reason = 'locator_missing';
        const replacement = await this.proveMisplacedRoleSelector(page, locator);
        if (replacement) issue.replacement_locator = replacement;
      } else if (actual !== undefined) return;
      else if (count > 1) issue.reason = 'locator_ambiguous';
    } catch {
      // Keep the failure diagnostic when the selector or browser is unusable.
    }
    return issue;
  }

  async setBrowser(browser: Browser): Promise<void> {
    this.browser = browser;
    browser.once('disconnected', () => {
      void this.closeProfiles().catch(() => undefined);
    });
    const run = await updateRun(this.options.runDirectory, (run) => {
      run.versions.browser = browser.version();
    });
    this.runId = run.id;
    this.packageId = run.package_id;
  }

  private async openContext(actor?: string): Promise<void> {
    if (!this.browser) throw new Error('The browser runner is unavailable.');
    await this.closeProfiles();
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
    try {
      await this.configureContext(this.context);
      this.page = await this.context.newPage();
    } catch (error) {
      await this.context.close().catch(() => undefined);
      this.context = undefined;
      throw error;
    }
    this.masks = [];
    this.profiles.set('main', {
      context: this.context,
      tabs: new Map([['main', { page: this.page, masks: this.masks }]]),
      activeTab: 'main',
    });
    this.activeProfile = 'main';
    this.currentActor = actor;
  }

  private async configureContext(context: BrowserContext): Promise<void> {
    context.setDefaultTimeout(this.plan.environment.timeout_ms);
    context.setDefaultNavigationTimeout(this.plan.environment.timeout_ms);
    await context.route('**/*', async (route) => {
      try {
        checkedUrl(route.request().url(), this.plan);
        await route.continue();
      } catch {
        await route.abort('blockedbyclient');
      }
    });
    await context.routeWebSocket('**/*', (socket) => {
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
  }

  private async closeProfiles(): Promise<void> {
    if (this.closingProfiles) return this.closingProfiles;
    this.closingProfiles = (async () => {
      const profiles = [...this.profiles.values()];
      this.profiles.clear();
      await Promise.all(
        profiles.map(async ({ context, directory }) => {
          await context.close().catch(() => undefined);
          if (directory) await rm(directory, { recursive: true, force: true });
        }),
      );
      this.context = undefined;
      this.page = undefined;
      this.masks = [];
    })();
    try {
      await this.closingProfiles;
    } finally {
      this.closingProfiles = undefined;
    }
  }

  private selectProfile(name: string): RuntimeProfile {
    const profile = this.profiles.get(name);
    if (!profile) throw new Error(`Unknown browser profile ${name}.`);
    const tab = profile.tabs.get(profile.activeTab)!;
    if (tab.page.isClosed()) throw new Error(`Browser tab ${profile.activeTab} is closed.`);
    this.activeProfile = name;
    this.context = profile.context;
    this.page = tab.page;
    this.masks = tab.masks;
    return profile;
  }

  private async persistentContext(directory: string): Promise<BrowserContext> {
    const context = await chromium.launchPersistentContext(directory, {
      headless: true,
      locale: this.plan.environment.locale,
      timezoneId: this.plan.environment.timezone,
      viewport: this.plan.environment.viewport,
      serviceWorkers: 'block',
      acceptDownloads: true,
    });
    try {
      await this.configureContext(context);
    } catch (error) {
      await context.close();
      throw error;
    }
    return context;
  }

  private async browserAction(action: Extract<Action, { op: 'browser' }>): Promise<void> {
    if (action.url && !['open_tab', 'open_profile'].includes(action.command))
      throw new Error('Only opening a browser tab or profile accepts a URL.');
    const url = action.url ? checkedUrl(action.url, this.plan) : undefined;
    if (action.command === 'open_profile') {
      if (this.profiles.has(action.name) || this.profiles.size >= 4)
        throw new Error('Browser profiles must be unique; at most four may be open per case.');
      const directory = await mkdtemp(join(tmpdir(), 'provenarium-profile-'));
      let opened: BrowserContext | undefined;
      try {
        const context = (opened = await this.persistentContext(directory));
        const page = context.pages()[0] ?? (await context.newPage());
        this.profiles.set(action.name, {
          context,
          directory,
          tabs: new Map([['main', { page, masks: [] }]]),
          activeTab: 'main',
        });
        this.selectProfile(action.name);
        if (url) await page.goto(url, { waitUntil: 'domcontentloaded' });
      } catch (error) {
        if (!this.profiles.has(action.name)) {
          await opened?.close().catch(() => undefined);
          await rm(directory, { recursive: true, force: true });
        }
        throw error;
      }
      return;
    }
    if (action.command === 'select_profile') {
      this.selectProfile(action.name);
      return;
    }
    if (action.command === 'restart_profile') {
      const profile = this.profiles.get(action.name);
      if (!profile?.directory)
        throw new Error('Restart requires a named disposable persistent profile.');
      const tabs = [...profile.tabs].map(([name, tab]) => ({
        name,
        url: tab.page.url(),
        denied: Boolean(tab.storage),
        masks: tab.masks,
      }));
      const activeTab = profile.activeTab;
      await profile.context.close();
      const context = await this.persistentContext(profile.directory);
      profile.context = context;
      profile.tabs = new Map();
      for (const [index, tab] of tabs.entries()) {
        const page =
          index === 0 ? (context.pages()[0] ?? (await context.newPage())) : await context.newPage();
        const restored: RuntimeTab = { page, masks: tab.masks };
        profile.tabs.set(tab.name, restored);
        if (tab.denied) await this.setStorageMode(restored, context, true, false);
        if (tab.url !== 'about:blank')
          await page.goto(checkedUrl(tab.url, this.plan), { waitUntil: 'domcontentloaded' });
      }
      profile.activeTab = activeTab;
      this.selectProfile(action.name);
      return;
    }
    const profile = this.profiles.get(this.activeProfile)!;
    if (action.command === 'open_tab') {
      if (profile.tabs.has(action.name) || profile.tabs.size >= 8)
        throw new Error('Browser tabs must be unique; at most eight may be open per profile.');
      const page = await profile.context.newPage();
      profile.tabs.set(action.name, { page, masks: [] });
      profile.activeTab = action.name;
      this.selectProfile(this.activeProfile);
      if (url) await page.goto(url, { waitUntil: 'domcontentloaded' });
    } else {
      if (!profile.tabs.has(action.name)) throw new Error(`Unknown browser tab ${action.name}.`);
      profile.activeTab = action.name;
      this.selectProfile(this.activeProfile);
    }
  }

  private async setStorageMode(
    tab: RuntimeTab,
    context: BrowserContext,
    denied: boolean,
    reload = true,
  ): Promise<void> {
    if (denied === Boolean(tab.storage)) return;
    if (denied) {
      const session = await context.newCDPSession(tab.page);
      await session.send('Page.enable');
      const { identifier } = await session.send('Page.addScriptToEvaluateOnNewDocument', {
        source: DENY_STORAGE,
      });
      tab.storage = { session, identifier };
    } else {
      await tab.storage!.session.send('Page.removeScriptToEvaluateOnNewDocument', {
        identifier: tab.storage!.identifier,
      });
      await tab.storage!.session.detach();
      tab.storage = undefined;
    }
    if (reload) await tab.page.reload({ waitUntil: 'domcontentloaded' });
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
        await selected.waitFor({ state: 'visible' });
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

  private async retainDownload(download: Download, name: string): Promise<DownloadValue> {
    const path = join(
      this.options.runDirectory,
      'artifacts',
      `${this.caseId}-${this.stepId}-${name}.download`,
    );
    await download.saveAs(path);
    const artifact = await this.registerArtifact(path, name, 'download');
    const data = await readFile(path);
    let utf8Valid = true;
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
      utf8Valid = false;
    }
    const text = data.toString('utf8');
    const crlf = text.includes('\r\n');
    const withoutPairs = text.replaceAll('\r\n', '');
    const lf = withoutPairs.includes('\n');
    const cr = withoutPairs.includes('\r');
    const value: DownloadValue = {
      path: artifact.path,
      filename: basename(download.suggestedFilename()),
      artifact,
      byte_length: data.length,
      utf8_valid: utf8Valid,
      has_bom: data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf,
      line_endings:
        Number(crlf) + Number(lf) + Number(cr) > 1
          ? 'mixed'
          : crlf
            ? 'crlf'
            : lf
              ? 'lf'
              : cr
                ? 'cr'
                : 'none',
      final_newline: text.endsWith('\n') || text.endsWith('\r'),
    };
    if (data.length <= MAX_RESPONSE_BYTES && utf8Valid) value.text = text;
    return value;
  }

  private async dialogAction(action: Extract<Action, { op: 'dialog' }>): Promise<void> {
    const page = this.page!;
    const dialogs: { type: string; message: string }[] = [];
    const handled: Promise<void>[] = [];
    let failure: unknown;
    const listener = (dialog: Dialog) => {
      if (dialogs.length >= 20)
        failure ??= new Error('Dialog observation exceeded its event limit.');
      else dialogs.push({ type: dialog.type(), message: dialog.message() });
      // Unexpected dialogs are dismissed so a claimed absence can fail observably without hanging.
      handled.push(
        (action.response === 'accept' ? dialog.accept() : dialog.dismiss()).catch((error) => {
          failure ??= error;
        }),
      );
    };
    page.on('dialog', listener);
    try {
      await locate(page, action.locator).click();
      await new Promise((resolve) => setTimeout(resolve, action.timeout_ms ?? 1000));
    } finally {
      page.off('dialog', listener);
      await Promise.all(handled);
    }
    if (failure) throw failure;
    this.variables.set(action.as, {
      count: dialogs.length,
      type: dialogs[0]?.type ?? null,
      message: dialogs[0]?.message ?? null,
      dialogs,
    });
  }

  private async observeDownload(
    action: Extract<Action, { op: 'observe_download' }>,
  ): Promise<void> {
    const page = this.page!;
    const observed: Download[] = [];
    const cancelled: Promise<unknown>[] = [];
    let failure: unknown;
    let count = 0;
    const listener = (download: Download) => {
      count++;
      if (count > 20) {
        failure ??= new Error('Download observation exceeded its event limit.');
        cancelled.push(download.cancel().catch(() => undefined));
      } else observed.push(download);
    };
    let activated = false;
    page.on('download', listener);
    try {
      const target = locate(page, action.locator);
      await target.waitFor({ state: 'visible' });
      if (await target.isEnabled()) {
        await target.click();
        activated = true;
      }
      await new Promise((resolve) => setTimeout(resolve, action.timeout_ms ?? 1000));
    } finally {
      page.off('download', listener);
      await Promise.all(cancelled);
    }
    const downloads: DownloadValue[] = [];
    // Serial artifact registration preserves every entry in the run's atomic manifest.
    for (const [index, download] of observed.entries())
      downloads.push(await this.retainDownload(download, `${action.as}-${index + 1}`));
    if (failure) throw failure;
    this.variables.set(action.as, {
      count,
      activated,
      filenames: downloads.map((value) => value.filename),
      downloads,
    });
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
      case 'browser':
        await this.browserAction(action);
        break;
      case 'storage': {
        const profile = this.profiles.get(this.activeProfile)!;
        await this.setStorageMode(
          profile.tabs.get(profile.activeTab)!,
          profile.context,
          action.mode === 'denied',
        );
        break;
      }
      case 'dialog':
        await this.dialogAction(action);
        break;
      case 'observe_download':
        await this.observeDownload(action);
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
        this.variables.set(action.save_as, await this.retainDownload(download, action.save_as));
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
    // A CSS selector in the role-name field can falsely satisfy an absence
    // assertion. Check that known shape even when the comparison passed,
    // within the dry run only.
    const issue =
      this.onAssertionIssue &&
      (!matched || (assertion.locator && misplacedRoleSelector(assertion.locator)))
        ? await this.diagnoseAssertion(assertion, actual)
        : undefined;
    if (issue) {
      matched = false;
      this.onAssertionIssue?.(issue);
    }
    await this.observe({
      assertion_id: assertion.id,
      status: matched ? 'passed' : 'failed',
      expected: assertion.expected,
      actual,
      message: matched
        ? undefined
        : issue
          ? 'The browser could not locate or read the assertion target.'
          : 'Observed result did not satisfy the approved assertion.',
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
          for (const [index, action] of step.actions.entries()) {
            try {
              await this.action(action);
            } catch (error) {
              if (this.onActionIssue)
                this.onActionIssue(await this.diagnoseAction(action, index, error));
              throw error;
            }
          }
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
      await this.closeProfiles();
    }
  }
}
