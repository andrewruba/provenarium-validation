import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { z } from 'zod';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { locatorSchema, type Bindings, type LocatorSpec } from '../schema.js';
import { assertAllowedUrl, redact, redactValue, safeUrl } from './security.js';
import type { ContextHash } from '../context.js';
import { matchDeployedScripts } from './source-correspondence.js';

export const discoveryActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('inspect') }),
  z.strictObject({ action: z.literal('navigate'), url: z.string() }),
  z.strictObject({ action: z.literal('click'), locator: locatorSchema }),
  z.strictObject({
    action: z.literal('fill'),
    locator: locatorSchema,
    value: z.string().max(1024),
  }),
  z.strictObject({
    action: z.literal('select'),
    locator: locatorSchema,
    value: z.string().max(1024),
  }),
  z.strictObject({ action: z.literal('fillSecret'), locator: locatorSchema, binding: z.string() }),
  z.strictObject({ action: z.literal('finish') }),
]);
export type DiscoveryAction = z.infer<typeof discoveryActionSchema>;
export type PageObservation = {
  url: string;
  title: string;
  text: string;
  controls: unknown[];
  links: unknown[];
  warning?: string;
};
export type DiscoveryOptions = {
  root?: string;
  url: string;
  allowedOrigins?: string[];
  bindings?: Bindings;
  discoveryActor?: string;
  allowInteractions?: boolean;
  signal?: AbortSignal;
};

function locator(page: Page, spec: LocatorSpec): Locator {
  if (spec.by === 'role')
    return page.getByRole((spec.role ?? 'button') as Parameters<Page['getByRole']>[0], {
      name: spec.value,
      exact: spec.exact,
    });
  if (spec.by === 'label') return page.getByLabel(spec.value, { exact: spec.exact });
  if (spec.by === 'text') return page.getByText(spec.value, { exact: spec.exact });
  if (spec.by === 'testId') return page.getByTestId(spec.value);
  return page.locator(spec.value);
}

/** Only these compiler-owned browser actions can be requested during discovery.
 * No provider content is evaluated as code or passed to filesystem/shell tools. */
export class Discovery {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private readonly origins: string[];
  private readonly secrets: string[];
  private readonly options: DiscoveryOptions;
  private readonly abort = () => {
    void this.close();
  };
  constructor(options: DiscoveryOptions) {
    this.options = options;
    const target = safeUrl(options.url);
    this.origins = [
      ...new Set([target.origin, ...(options.allowedOrigins ?? []).map((x) => safeUrl(x).origin)]),
    ];
    this.secrets = Object.values(options.bindings ?? {}).flatMap((b) =>
      [b.password, b.token].filter((s): s is string => Boolean(s)),
    );
  }
  async open(): Promise<PageObservation> {
    this.options.signal?.throwIfAborted();
    let storageState: string | undefined;
    const sessions = Object.entries(this.options.bindings ?? {}).filter(
      ([, binding]) => binding.storageState,
    );
    if (sessions.length > 1 && !this.options.discoveryActor)
      throw new Error(
        'Several discovery sessions are available. Select a discovery actor explicitly.',
      );
    const selected = this.options.discoveryActor
      ? sessions.find(([id]) => id === this.options.discoveryActor)
      : sessions[0];
    if (this.options.discoveryActor && !selected)
      throw new Error('The selected discovery actor has no reusable session.');
    if (selected) {
      if (!this.options.root)
        throw new Error('A project root is required for authenticated discovery.');
      const directory = await realpath(path.join(this.options.root, '.provenarium', 'auth'));
      storageState = await realpath(path.resolve(this.options.root, selected[1].storageState!));
      if (!storageState.startsWith(directory + path.sep))
        throw new Error('Discovery session must remain in the local authentication directory.');
      const state = z
        .object({
          cookies: z.array(z.object({ value: z.string() })),
          origins: z.array(z.object({ localStorage: z.array(z.object({ value: z.string() })) })),
        })
        .parse(JSON.parse(await readFile(storageState, 'utf8')));
      this.secrets.push(
        ...state.cookies.map((cookie) => cookie.value),
        ...state.origins.flatMap((origin) => origin.localStorage.map((item) => item.value)),
      );
    }
    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({
      locale: 'en-US',
      timezoneId: 'UTC',
      viewport: { width: 1280, height: 800 },
      storageState,
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    await this.context.route('**/*', async (route) => {
      try {
        assertAllowedUrl(route.request().url(), this.options.url, this.origins);
        if (
          !this.options.allowInteractions &&
          !['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())
        )
          return route.abort('blockedbyclient');
        return route.continue();
      } catch {
        return route.abort('blockedbyclient');
      }
    });
    await this.context.routeWebSocket('**/*', (socket) => socket.close());
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(8000);
    this.page.on('dialog', (dialog) => {
      void dialog.dismiss();
    });
    this.options.signal?.addEventListener('abort', this.abort, { once: true });
    await this.page.goto(this.options.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    return this.snapshot();
  }
  async snapshot(): Promise<PageObservation> {
    this.options.signal?.throwIfAborted();
    if (!this.page) throw new Error('Discovery is not open.');
    const url = assertAllowedUrl(this.page.url(), this.options.url, this.origins);
    const storage = await this.context!.storageState();
    for (const secret of [
      ...storage.cookies.map((cookie) => cookie.value),
      ...storage.origins.flatMap((origin) => origin.localStorage.map((item) => item.value)),
    ]) {
      if (secret && !this.secrets.includes(secret)) this.secrets.push(secret);
    }
    // This DOM extraction is fixed trusted code. Passwords, hidden controls,
    // scripts, storage, network bodies and screenshots are never sent to a model.
    const raw = await this.page.locator('body').evaluate((body) => {
      const clone = body.cloneNode(true) as HTMLElement;
      clone
        .querySelectorAll('script,style,noscript,template,input[type=password],input[type=hidden]')
        .forEach((el) => el.remove());
      const controls = Array.from(
        body.querySelectorAll('input,select,textarea,button,[role=button]'),
      )
        .slice(0, 100)
        .map((el) => {
          const input = el as HTMLInputElement;
          const secret =
            input.type === 'password' || /token|password|secret|api.?key/i.test(input.name ?? '');
          if (input.type === 'hidden') return null;
          return {
            tag: el.tagName.toLowerCase(),
            type: input.type || '',
            id: el.id,
            name: el.getAttribute('name') ?? '',
            label:
              input.labels?.[0]?.textContent?.trim() ??
              el.getAttribute('aria-label') ??
              el.textContent?.trim().slice(0, 120) ??
              '',
            testId: el.getAttribute('data-testid'),
            value: secret ? '[SECRET CONTROL]' : (input.value ?? '').slice(0, 200),
            required: input.required ?? false,
            disabled: input.disabled ?? false,
            choices:
              el.tagName === 'SELECT'
                ? Array.from((el as HTMLSelectElement).options).map((o) => ({
                    label: o.text,
                    value: o.value,
                  }))
                : undefined,
          };
        })
        .filter(Boolean);
      const links = Array.from(body.querySelectorAll('a[href]'))
        .slice(0, 60)
        .map((el) => ({
          text: el.textContent?.trim().slice(0, 120),
          href: el.getAttribute('href'),
        }));
      return {
        text: (clone.innerText || clone.textContent || '').slice(0, 12000),
        controls,
        links,
      };
    });
    const sanitized = redactValue(raw, this.secrets);
    sanitized.links = sanitized.links.filter((link) => {
      try {
        return Boolean(link.href && assertAllowedUrl(link.href, url, this.origins));
      } catch {
        return false;
      }
    });
    return { url, title: redact(await this.page.title(), this.secrets), ...sanitized };
  }
  async sourceCorrespondence(hashes: ContextHash[]) {
    if (!this.page) throw new Error('Discovery is not open.');
    const scripts = await this.page
      .locator('script[src]')
      .evaluateAll((elements) => elements.map((element) => (element as HTMLScriptElement).src));
    return matchDeployedScripts(scripts, hashes, this.options.url, this.origins, {
      signal: this.options.signal,
    });
  }
  async perform(raw: DiscoveryAction): Promise<PageObservation> {
    this.options.signal?.throwIfAborted();
    const action = discoveryActionSchema.parse(raw);
    if (!this.page) throw new Error('Discovery is not open.');
    if (action.action === 'finish' || action.action === 'inspect') return this.snapshot();
    if (action.action === 'navigate') {
      await this.page.goto(assertAllowedUrl(action.url, this.options.url, this.origins), {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
    } else {
      if (!this.options.allowInteractions)
        throw new Error(
          'Interactive discovery was not authorized. Use read-only navigation or retain an open question.',
        );
      const target = locator(this.page, action.locator);
      if (action.action === 'click') await target.click();
      else if (action.action === 'select') await target.selectOption(action.value);
      else if (action.action === 'fill') {
        if (
          (await target.getAttribute('type')) === 'password' ||
          /token|password|secret/i.test((await target.getAttribute('name')) ?? '')
        )
          throw new Error('Secret fields require a named credential binding.');
        await target.fill(action.value);
      } else if (action.action === 'fillSecret') {
        const [actor, field, ...rest] = action.binding.split('.');
        if (rest.length || !['username', 'password', 'token'].includes(field ?? ''))
          throw new Error('Unsupported credential binding.');
        const binding = this.options.bindings?.[actor];
        const value = binding?.[field as 'username' | 'password' | 'token'];
        if (!value) throw new Error('The requested credential binding is unavailable.');
        await target.fill(value);
      }
      await this.page.waitForLoadState('domcontentloaded').catch(() => undefined);
    }
    return this.snapshot();
  }
  async close(): Promise<void> {
    this.options.signal?.removeEventListener('abort', this.abort);
    await this.browser?.close().catch(() => undefined);
    this.browser = undefined;
    this.page = undefined;
    this.context = undefined;
  }
}
