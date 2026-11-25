#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '_site');
const { values } = parseArgs({ options: { port: { type: 'string', default: '4176' } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
if (!(await stat(resolve(root, 'index.html'))).isFile()) throw new Error('Build Pages first.');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};
const server = createServer(async (request, response) => {
  try {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      return response.end();
    }
    const url = new URL(request.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    let file = resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(root + sep)) throw new Error('Invalid path.');
    if ((await stat(file)).isDirectory()) {
      if (!pathname.endsWith('/')) {
        response.writeHead(308, { Location: `${url.pathname}/${url.search}` });
        return response.end();
      }
      file = resolve(file, 'index.html');
    }
    const content = await readFile(file);
    response.writeHead(200, {
      'Content-Type': types[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found.');
  }
});
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  console.log(`Pages demo: http://127.0.0.1:${address.port}/`);
});
const stop = () => {
  server.closeAllConnections();
  server.close();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
