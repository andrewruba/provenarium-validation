import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Discovery } from '../src/authoring/discovery.js';

let server: Server;
let origin: string;
let mutations = 0;
const browsers: Discovery[] = [];
beforeEach(async () => {
  mutations = 0;
  server = createServer((request, response) => {
    if (request.method === 'POST') {
      mutations++;
      response.end('unexpected mutation');
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.setHeader('set-cookie', 'session=COOKIE_SENTINEL; HttpOnly; Path=/');
    response.end(
      '<html><head><title>Receipt register</title></head><body>' +
        '<h1>Login</h1><p>COOKIE_SENTINEL</p><form method="POST">' +
        '<label>Username<input name="username"></label>' +
        '<label>Password<input name="password" type="password" value="PASSWORD_IN_CONTROL"></label>' +
        '<input type="hidden" value="HIDDEN_SENTINEL"><button>Sign in</button></form>' +
        '<a href="https://example.com/?token=URL_SENTINEL">External</a>' +
        '<script>window.sample="SCRIPT_SENTINEL";fetch("/",{method:"POST"}).catch(()=>{});</script>' +
        '</body></html>',
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
});

it('takes a read-only snapshot and excludes secret controls, cookies, scripts and external links', async () => {
  const browser = new Discovery({ url: origin });
  browsers.push(browser);
  const snapshot = await browser.open();
  expect(snapshot.title).toBe('Receipt register');
  expect(snapshot.text).toContain('[REDACTED]');
  expect(JSON.stringify(snapshot)).toContain('Username');
  expect(JSON.stringify(snapshot)).not.toMatch(
    /COOKIE_SENTINEL|PASSWORD_IN_CONTROL|HIDDEN_SENTINEL|SCRIPT_SENTINEL|URL_SENTINEL/,
  );
  expect(mutations).toBe(0);
});
