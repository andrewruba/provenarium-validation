import type { BrowserContext } from '@playwright/test';

const MAX_HTTP_BYTES = 2 * 1024 * 1024;
type CookieInput = Parameters<BrowserContext['addCookies']>[0][number];
type Session = Pick<BrowserContext, 'cookies' | 'addCookies'>;

/** Parse a Set-Cookie response into a host-scoped browser cookie. Invalid cookies are ignored. */
export function responseCookie(header: string, target: URL): CookieInput | undefined {
  const [pair, ...attributes] = header.split(';');
  const equals = pair.indexOf('=');
  if (equals <= 0) return;
  const name = pair.slice(0, equals).trim(),
    value = pair.slice(equals + 1).trim();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\x00-\x20\x7f;]/.test(value)) return;
  const properties = new Map(
    attributes.map((attribute) => {
      const i = attribute.indexOf('=');
      return [
        attribute
          .slice(0, i < 0 ? undefined : i)
          .trim()
          .toLowerCase(),
        i < 0 ? '' : attribute.slice(i + 1).trim(),
      ];
    }),
  );
  const domain = properties.get('domain')?.replace(/^\./, '').toLowerCase();
  // Browser requests provide full Domain-cookie behavior. Bounded HTTP checks never expand cookie scope.
  if (domain && domain !== target.hostname.toLowerCase()) return;
  const defaultPath = target.pathname.includes('/')
    ? target.pathname.slice(0, target.pathname.lastIndexOf('/')) || '/'
    : '/';
  const path = properties.get('path')?.startsWith('/') ? properties.get('path')! : defaultPath;
  const secure = properties.has('secure');
  if (name.startsWith('__Secure-') && !secure) return;
  if (name.startsWith('__Host-') && (!secure || domain || path !== '/')) return;
  const cookie: CookieInput = {
    name,
    value,
    domain: target.hostname,
    path,
    secure,
    httpOnly: properties.has('httponly'),
  };
  const sameSite = properties.get('samesite')?.toLowerCase();
  if (sameSite === 'strict') cookie.sameSite = 'Strict';
  if (sameSite === 'lax') cookie.sameSite = 'Lax';
  if (sameSite === 'none') {
    if (!secure) return;
    cookie.sameSite = 'None';
  }
  const maxAge = properties.get('max-age');
  if (maxAge && /^-?\d+$/.test(maxAge) && Number.isFinite(Number(maxAge)))
    cookie.expires = Math.max(
      1,
      Math.floor(Date.now() / 1000) + Math.min(Number(maxAge), 400 * 24 * 60 * 60),
    );
  else if (properties.has('expires')) {
    const date = Date.parse(properties.get('expires')!);
    if (Number.isFinite(date)) cookie.expires = Math.max(1, Math.floor(date / 1000));
  }
  return cookie;
}

/** HTTP checks stream at most 2 MiB, never follow redirects, and reuse only matching browser cookies. */
export async function boundedHttpRequest(
  session: Session,
  url: string,
  options: {
    method: string;
    body?: unknown;
    authToken?: string;
    timeoutMs: number;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; body: unknown; text: string }> {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
    throw new Error('Unsupported HTTP check URL.');
  const cookies = await session.cookies(url);
  const applicable = cookies.filter((cookie) => {
    const domain = cookie.domain.replace(/^\./, '').toLowerCase();
    const hostname = target.hostname.toLowerCase();
    const domainMatches =
      hostname === domain || (cookie.domain.startsWith('.') && hostname.endsWith(`.${domain}`));
    const pathMatches =
      target.pathname === cookie.path ||
      target.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`);
    return (
      domainMatches &&
      pathMatches &&
      /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name) &&
      !/[\x00-\x20\x7f;]/.test(cookie.value) &&
      (!cookie.secure || target.protocol === 'https:')
    );
  });
  const headers: Record<string, string> = {};
  if (applicable.length)
    headers.cookie = applicable.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  if (options.authToken) headers.authorization = `Bearer ${options.authToken}`;
  let body: string | undefined;
  if (options.body !== undefined) {
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    headers['content-type'] =
      typeof options.body === 'string' ? 'text/plain; charset=utf-8' : 'application/json';
    if (Buffer.byteLength(body) > MAX_HTTP_BYTES)
      throw new Error('HTTP request exceeds the supported 2 MiB limit.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  timer.unref();
  try {
    const response = await fetchImpl(url, {
      method: options.method,
      body,
      headers,
      redirect: 'manual',
      signal: controller.signal,
    });
    if (Number(response.headers.get('content-length')) > MAX_HTTP_BYTES) {
      await response.body?.cancel();
      throw new Error('HTTP observation exceeds the supported 2 MiB limit.');
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          length += next.value.byteLength;
          if (length > MAX_HTTP_BYTES) {
            await reader.cancel();
            controller.abort();
            throw new Error('HTTP observation exceeds the supported 2 MiB limit.');
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const updates = response.headers
      .getSetCookie()
      .map((header) => responseCookie(header, target))
      .filter((cookie): cookie is CookieInput => Boolean(cookie));
    if (updates.length) await session.addCookies(updates);
    const text = Buffer.concat(chunks).toString('utf8');
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* plain-text response */
    }
    return { status: response.status, body: parsed, text };
  } finally {
    clearTimeout(timer);
  }
}
