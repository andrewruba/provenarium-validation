import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { assertAllowedUrl, redact, redactValue, safeUrl } from './security.js';
import type { ContextHash } from '../context.js';
import { matchDeployedScripts } from './source-correspondence.js';

export type PageObservation = {
  url: string;
  title: string;
  text: string;
  controls: unknown[];
  links: unknown[];
};
type DiscoveryOptions = {
  url: string;
  signal?: AbortSignal;
};

/** Observe the app through a read-only browser session before drafting. */
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
    this.origins = [safeUrl(options.url).origin];
    this.secrets = [];
  }
  async open(): Promise<PageObservation> {
    this.options.signal?.throwIfAborted();
    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({
      locale: 'en-US',
      timezoneId: 'UTC',
      viewport: { width: 1280, height: 800 },
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    await this.context.route('**/*', async (route) => {
      try {
        assertAllowedUrl(route.request().url(), this.options.url, this.origins);
        if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method()))
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
  private async snapshot(): Promise<PageObservation> {
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
  async close(): Promise<void> {
    this.options.signal?.removeEventListener('abort', this.abort);
    await this.browser?.close().catch(() => undefined);
    this.browser = undefined;
    this.page = undefined;
    this.context = undefined;
  }
}
