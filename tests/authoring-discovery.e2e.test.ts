import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Discovery } from '../src/authoring/discovery.js';

let server: Server;
let origin: string;
let mutations = 0;
let directory: string;
const browsers: Discovery[] = [];
beforeEach(async () => {
  mutations = 0;
  directory = await mkdtemp(path.join(tmpdir(), 'provenarium-discovery-'));
  server = createServer(async (request, response) => {
    if (request.method === 'POST') {
      mutations++;
      let body = '';
      for await (const chunk of request) body += chunk;
      const password = new URLSearchParams(body).get('password') ?? '';
      response.setHeader('content-type', 'text/html');
      response.end(
        '<h1>Saved</h1><p>' +
          password.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') +
          '</p>',
      );
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end(
      `<html><head><title>Receipt register</title></head><body><h1>${request.headers.cookie?.includes('session=synthetic') ? 'Authenticated' : 'Login'}</h1><form method="POST"><label>Username<input name="username"></label><label>Password<input name="password" type="password" value="PASSWORD_IN_CONTROL"></label><input type="hidden" value="HIDDEN_SENTINEL"><button type="submit">Sign in</button></form><a href="https://example.com/?token=URL_SENTINEL">External</a><script>window.sample='SCRIPT_SENTINEL';</script></body></html>`,
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
afterEach(async () => {
  await Promise.all(browsers.splice(0).map((browser) => browser.close()));
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});
function discovery(options: Partial<ConstructorParameters<typeof Discovery>[0]> = {}) {
  const browser = new Discovery({ root: directory, url: origin, ...options });
  browsers.push(browser);
  return browser;
}
describe('bounded browser discovery', () => {
  it('exposes useful controls without hidden inputs, script contents or password values', async () => {
    const snapshot = await discovery().open();
    expect(snapshot.title).toBe('Receipt register');
    expect(JSON.stringify(snapshot)).toContain('Username');
    expect(JSON.stringify(snapshot)).not.toMatch(
      /PASSWORD_IN_CONTROL|HIDDEN_SENTINEL|SCRIPT_SENTINEL|URL_SENTINEL/,
    );
  });
  it('requires interaction authorization and refuses external navigation', async () => {
    const browser = discovery();
    await browser.open();
    await expect(
      browser.perform({
        action: 'click',
        locator: { by: 'role', role: 'button', value: 'Sign in', exact: true },
      }),
    ).rejects.toThrow(/not authorized/);
    await expect(
      browser.perform({ action: 'navigate', url: 'https://example.com/' }),
    ).rejects.toThrow(/outside/);
    expect(mutations).toBe(0);
  });
  it('resolves a secret locally and redacts it even if the app echoes special characters', async () => {
    const secret = 'SENTINEL"with&characters';
    const browser = discovery({
      allowInteractions: true,
      bindings: { operator: { username: 'operator', password: secret } },
    });
    await browser.open();
    await browser.perform({
      action: 'fillSecret',
      locator: { by: 'label', value: 'Password', exact: true },
      binding: 'operator.password',
    });
    const snapshot = await browser.perform({
      action: 'click',
      locator: { by: 'role', role: 'button', value: 'Sign in', exact: true },
    });
    expect(mutations).toBe(1);
    expect(snapshot.text).toContain('[REDACTED]');
    expect(snapshot.text).not.toContain(secret);
  });
  it('loads an explicitly local reusable session', async () => {
    await mkdir(path.join(directory, '.provenarium', 'auth'), { recursive: true });
    const filename = path.join(directory, '.provenarium', 'auth', 'operator.json');
    await writeFile(
      filename,
      JSON.stringify({
        cookies: [
          {
            name: 'session',
            value: 'synthetic',
            domain: '127.0.0.1',
            path: '/',
            expires: -1,
            httpOnly: true,
            secure: false,
            sameSite: 'Lax',
          },
        ],
        origins: [],
      }),
    );
    const snapshot = await discovery({
      bindings: { operator: { username: 'operator', storageState: filename } },
    }).open();
    expect(snapshot.text).toContain('Authenticated');
  });
  it('rejects session paths outside the authentication directory', async () => {
    await mkdir(path.join(directory, '.provenarium', 'auth'), { recursive: true });
    const filename = path.join(directory, 'outside.json');
    await writeFile(filename, '{"cookies":[],"origins":[]}');
    await expect(
      discovery({ bindings: { operator: { storageState: filename } } }).open(),
    ).rejects.toThrow(/local authentication/);
  });
});
