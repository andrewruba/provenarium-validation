import { describe, expect, it, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertionSchema, planSchema } from '../src/schema.js';
import { checkedUrl, compare } from '../src/runtime/engine.js';
import {
  containedPath,
  redactor,
  variableValue,
  digest,
  secretFieldValues,
} from '../src/runtime/io.js';
import { boundedHttpRequest, responseCookie } from '../src/runtime/http.js';
import { validateBindings } from '../src/credentials.js';
import { verifyApprovedPackage } from '../src/runtime/index.js';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function directory() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'provenarium-runtime-test-')));
  temporary.push(path);
  return path;
}
const plan = () =>
  planSchema.parse({
    schema_version: 1,
    runtime_version: 1,
    id: 'plan',
    title: 'Test',
    urs_revision: '1',
    target: { url: 'https://example.test/app', allowed_origins: ['https://example.test'] },
    environment: {},
    obligations: [],
    cases: [{ id: 'C1', title: 'Test', classification: 'OQ', requirements: ['R1'], steps: [] }],
  });

describe('runtime trust boundaries', () => {
  it('rejects traversal and symlink paths while allowing missing children inside the package', async () => {
    const root = await directory();
    await mkdir(join(root, 'fixtures'));
    expect(await containedPath(root, 'fixtures/input.csv')).toBe(join(root, 'fixtures/input.csv'));
    for (const path of [
      '../secrets',
      '/tmp/secrets',
      'fixtures/../../secrets',
      'fixtures\\secret',
      'fixtures//secret',
    ]) {
      await expect(containedPath(root, path)).rejects.toThrow();
    }
    await symlink('/tmp', join(root, 'escape'));
    await expect(containedPath(root, 'escape/input')).rejects.toThrow(/Symlinks/);
  });

  it('requires approved origins and rejects credentials and alternate protocols', () => {
    expect(checkedUrl('/records', plan())).toBe('https://example.test/records');
    for (const url of [
      'https://evil.test/',
      'https://example.test.evil.test/',
      'https://user:secret@example.test/',
      'file:///tmp/secret',
      'javascript:alert(1)',
    ]) {
      expect(() => checkedUrl(url, plan())).toThrow();
    }
  });

  it('redacts nested observations and encoded secrets without modifying booleans/numbers', () => {
    const clean = redactor(['private / value']);
    expect(
      clean({ error: 'secret=private / value', nested: ['private%20%2F%20value', 3, false] }),
    ).toEqual({ error: 'secret=[REDACTED]', nested: ['[REDACTED]', 3, false] });
    expect(
      secretFieldValues({
        body: { accessToken: 'secret', session_id: 'session', records: [{ value: 3 }] },
      }),
    ).toEqual(['secret', 'session']);
  });

  it('reads bounded observed fields without prototype traversal', () => {
    const values = new Map<string, unknown>([
      ['response', { status: 200, body: { records: [{ id: 'A' }] } }],
    ]);
    expect(variableValue(values, 'response.body.records.0.id')).toBe('A');
    expect(() => variableValue(values, 'response.constructor')).toThrow();
    expect(() => variableValue(values, 'response.body.missing')).toThrow();
    expect(() => variableValue(values, 'unknown')).toThrow();
  });

  it('checks exact credential fields before starting execution', () => {
    const p = plan();
    p.access = [
      {
        id: 'operator',
        role: 'operator',
        state: 'active',
        mode: 'credentials',
        purpose: 'login',
        cases: ['C1'],
        distinct_from: [],
      },
    ];
    p.cases[0].steps = [
      {
        id: 'S1',
        instruction: 'Login',
        actions: [
          {
            op: 'fillSecret',
            locator: { by: 'label', value: 'Password', exact: true },
            binding: 'operator.password',
          },
        ],
        assertions: [],
        evidence: [],
      },
    ];
    expect(() =>
      validateBindings(p.access, { operator: { username: 'operator', token: 'token-only' } }, p),
    ).toThrow(/operator.password/);
    expect(() =>
      validateBindings(p.access, { operator: { username: 'operator', password: 'password' } }, p),
    ).not.toThrow();
    p.access.push({
      id: 'reviewer',
      role: 'reviewer',
      state: 'active',
      mode: 'credentials',
      purpose: 'approval',
      cases: ['C1'],
      distinct_from: ['operator'],
    });
    expect(() =>
      validateBindings(
        p.access,
        {
          operator: { username: 'same', password: 'a' },
          reviewer: { username: 'same', password: 'b' },
        },
        p,
      ),
    ).toThrow(/distinct/);
  });

  it('executes only approval-listed files and rejects changed frozen inputs', async () => {
    const root = await directory();
    const packageRoot = join(root, 'packages', 'pkg-test');
    await mkdir(join(packageRoot, 'tests'), { recursive: true });
    const files = {
      'plan.json': JSON.stringify(plan()),
      'urs.yaml': 'schema_version: 1\n',
      'tests/C1.spec.cjs': 'module.exports = () => {};\n',
    };
    for (const [name, content] of Object.entries(files))
      await writeFile(join(packageRoot, name), content);
    await writeFile(
      join(packageRoot, 'approval.json'),
      JSON.stringify({
        schema_version: 1,
        runtime_version: 1,
        package_id: 'pkg-test',
        approved_at: new Date().toISOString(),
        tests: ['tests/C1.spec.cjs'],
        files: Object.fromEntries(
          Object.entries(files).map(([name, content]) => [name, digest(content)]),
        ),
      }),
    );
    await writeFile(
      join(packageRoot, 'tests', 'unapproved.spec.cjs'),
      'throw new Error("must never execute")',
    );
    const checked = await verifyApprovedPackage(root, 'pkg-test');
    expect(checked.tests).toEqual([join(packageRoot, 'tests', 'C1.spec.cjs')]);
    await writeFile(join(packageRoot, 'tests', 'C1.spec.cjs'), 'changed');
    await expect(verifyApprovedPackage(root, 'pkg-test')).rejects.toThrow(/changed/);
  });
});

describe('bounded HTTP checks', () => {
  it('retains redirect status without visiting the redirect destination', async () => {
    const session = { cookies: vi.fn(async () => []), addCookies: vi.fn(async () => {}) };
    const transport = vi.fn(async (_url: unknown, options: RequestInit | undefined) => {
      expect(options?.redirect).toBe('manual');
      return new Response('', { status: 302, headers: { location: 'https://outside.test/' } });
    });
    const result = await boundedHttpRequest(
      session,
      'https://example.test/private',
      { method: 'GET', timeoutMs: 1000 },
      transport as unknown as typeof fetch,
    );
    expect(result.status).toBe(302);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('streams a bounded response and never follows redirects', async () => {
    let cancelled = false;
    const session = { cookies: vi.fn(async () => []), addCookies: vi.fn(async () => {}) };
    const transport = vi.fn(async (_url: unknown, options: RequestInit | undefined) => {
      expect(options?.redirect).toBe('manual');
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(2 * 1024 * 1024));
            controller.enqueue(new Uint8Array(1));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    });
    await expect(
      boundedHttpRequest(
        session,
        'https://example.test/data',
        { method: 'GET', timeoutMs: 1000 },
        transport as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/2 MiB/);
    expect(cancelled).toBe(true);
  });

  it('sends only matching browser cookies and applies host-scoped response cookies', async () => {
    const cookie = {
      name: 'session',
      value: 'secret',
      domain: 'example.test',
      path: '/',
      secure: false,
      httpOnly: true,
      expires: -1,
      sameSite: 'Lax' as const,
    };
    const session = {
      cookies: vi.fn(async () => [
        cookie,
        { ...cookie, name: 'other', domain: 'other.test' },
        { ...cookie, name: 'private', path: '/admin' },
        { ...cookie, name: 'secure', secure: true },
      ]),
      addCookies: vi.fn(async () => {}),
    };
    const transport = vi.fn(async (_url: unknown, options: RequestInit | undefined) => {
      expect(options?.headers).toMatchObject({ cookie: 'session=secret' });
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'set-cookie': 'next=new-session; Path=/; HttpOnly; SameSite=Lax' },
      });
    });
    const result = await boundedHttpRequest(
      session,
      'http://example.test/data',
      { method: 'GET', timeoutMs: 1000 },
      transport as unknown as typeof fetch,
    );
    expect(result.body).toEqual({ ok: true });
    expect(session.cookies).toHaveBeenCalledWith('http://example.test/data');
    expect(session.addCookies).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'next',
        value: 'new-session',
        domain: 'example.test',
        path: '/',
        httpOnly: true,
      }),
    ]);
    expect(
      responseCookie('bad=value; Domain=other.test', new URL('https://example.test/')),
    ).toBeUndefined();
    expect(
      responseCookie(
        '__Host-bad=value; Secure; Domain=example.test; Path=/',
        new URL('https://example.test/'),
      ),
    ).toBeUndefined();
  });
});

describe('fixed assertion semantics', () => {
  const assertion = (comparison: string, expected?: unknown, tolerance?: number) =>
    assertionSchema.parse({ id: 'A1', variable: 'observed', comparison, expected, tolerance });
  it('compares numeric tolerances without accepting blank strings or nonfinite values', () => {
    expect(compare('2.01', assertion('numeric', 2, 0.02))).toBe(true);
    expect(compare('', assertion('numeric', 0, 1))).toBe(false);
    expect(compare('NaN', assertion('numeric', 0, 1))).toBe(false);
    expect(compare('2.1', assertion('numeric', 2, 0.02))).toBe(false);
  });
  it('compares complete table contents and uses bounded wildcards instead of regex execution', () => {
    expect(
      compare(
        [
          ['ID', 'Value'],
          ['A', '2'],
        ],
        assertion('equals', [
          ['ID', 'Value'],
          ['A', '2'],
        ]),
      ),
    ).toBe(true);
    expect(
      compare(
        [
          ['ID', 'Value'],
          ['A', '3'],
        ],
        assertion('equals', [
          ['ID', 'Value'],
          ['A', '2'],
        ]),
      ),
    ).toBe(false);
    expect(compare('Saved record DEMO-1', assertion('matches', 'Saved record *'))).toBe(true);
    expect(compare('anything', assertion('matches', '(a+)+$'))).toBe(false);
  });
});
