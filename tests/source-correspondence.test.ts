import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { matchDeployedScripts } from '../src/authoring/source-correspondence.js';

const origin = 'https://app.example.test';
const bytes = Buffer.from('\ufeffconst label = "α";\r\n');
const hash = {
  source: 'source-1',
  location: 'app.js',
  sha256: createHash('sha256').update(bytes).digest('hex'),
};

it('matches exact script bytes with metadata only, including BOM and CRLF', async () => {
  const fetchImpl = vi.fn(async () => new Response(bytes));
  const matches = await matchDeployedScripts(
    ['/assets/app.js', '/assets/app.js'],
    [hash],
    origin,
    [origin],
    { fetchImpl },
  );
  expect(matches).toEqual([{ ...hash, deployed_url: origin + '/assets/app.js' }]);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(matches)).not.toContain('const label');
});

it('never claims a byte match for normalized or different source, errors, or missing assets', async () => {
  for (const response of [
    new Response(bytes.toString().replaceAll('\r\n', '\n')),
    new Response('different'),
    new Response('absent', { status: 404 }),
  ]) {
    expect(
      await matchDeployedScripts(['/app.js'], [hash], origin, [origin], {
        fetchImpl: async () => response,
      }),
    ).toEqual([]);
  }
});

it('validates every redirect and refuses other origins and secret-bearing URLs before fetching', async () => {
  const fetchImpl = vi.fn(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://outside.example/script.js' },
      }),
  );
  expect(
    await matchDeployedScripts(
      [
        '/app.js',
        'https://outside.example/script.js',
        '/app.js?token=secret',
        'https://user:secret@app.example.test/app.js',
      ],
      [hash],
      origin,
      [origin],
      { fetchImpl },
    ),
  ).toEqual([]);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('follows an in-scope redirect and bounds redirect loops', async () => {
  const fetchImpl = vi.fn(async (url: string | URL | Request) =>
    String(url).endsWith('/app.js')
      ? new Response(null, { status: 302, headers: { location: '/build.js' } })
      : new Response(bytes),
  );
  expect(await matchDeployedScripts(['/app.js'], [hash], origin, [origin], { fetchImpl })).toEqual([
    { ...hash, deployed_url: origin + '/build.js' },
  ]);
  const loop = vi.fn(
    async () => new Response(null, { status: 302, headers: { location: '/loop.js' } }),
  );
  expect(
    await matchDeployedScripts(['/loop.js'], [hash], origin, [origin], { fetchImpl: loop }),
  ).toEqual([]);
  expect(loop).toHaveBeenCalledTimes(4);
});

it('bounds downloaded bodies and does no work without eligible local hashes', async () => {
  const large = vi.fn(async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1)));
  expect(
    await matchDeployedScripts(['/app.js'], [hash], origin, [origin], { fetchImpl: large }),
  ).toEqual([]);
  const unused = vi.fn();
  expect(
    await matchDeployedScripts(
      ['/app.js'],
      [{ ...hash, location: 'design.md' }],
      origin,
      [origin],
      { fetchImpl: unused },
    ),
  ).toEqual([]);
  expect(unused).not.toHaveBeenCalled();
});

it('propagates caller cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    matchDeployedScripts(['/app.js'], [hash], origin, [origin], { signal: controller.signal }),
  ).rejects.toThrow();
});
