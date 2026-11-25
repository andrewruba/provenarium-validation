import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractContext } from '../src/context.js';
import { redact } from '../src/authoring/security.js';

const directories: string[] = [];
async function temporary() {
  const root = await mkdtemp(path.join(tmpdir(), 'provenarium-context-'));
  directories.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
describe('bounded context extraction', () => {
  it('extracts named sources with raw-content hashes and filters secret/generated material', async () => {
    const root = await temporary();
    await mkdir(path.join(root, 'source'));
    await mkdir(path.join(root, 'source', 'node_modules'));
    await writeFile(
      path.join(root, 'source', 'design.md'),
      '# Intended use\nOperators register samples.',
    );
    await writeFile(path.join(root, 'source', '.env'), 'API_KEY=private');
    await writeFile(path.join(root, 'source', 'credentials.json'), '{"password":"private"}');
    await writeFile(path.join(root, 'source', 'node_modules', 'module.js'), 'ignored');
    const bundle = await extractContext(root, [{ id: 'app', path: 'source' }]);
    expect(bundle.passages).toHaveLength(1);
    expect(bundle.passages[0].text).toContain('Operators');
    expect(JSON.stringify(bundle)).not.toContain('private');
    expect(bundle.hashes[0].sha256).toBe(
      createHash('sha256')
        .update(await readFile(path.join(root, 'source', 'design.md')))
        .digest('hex'),
    );
  });
  it('keeps unsupported, unreadable, and partial extraction visible', async () => {
    const root = await temporary();
    await writeFile(path.join(root, 'long.txt'), 'a'.repeat(40000));
    await writeFile(path.join(root, 'video.mov'), 'binary');
    const bundle = await extractContext(root, [
      { id: 'text', path: 'long.txt' },
      { id: 'video', path: 'video.mov' },
      { id: 'missing', path: 'missing.md' },
    ]);
    expect(bundle.passages[0].text).toHaveLength(32000);
    expect(bundle.warnings.join('\n')).toMatch(/partially extracted/);
    expect(bundle.warnings.join('\n')).toMatch(/unsupported format/);
    expect(bundle.warnings.join('\n')).toMatch(/missing/);
  });
  it('does not follow symlinks outside a linked directory', async () => {
    const root = await temporary();
    const outside = await temporary();
    await mkdir(path.join(root, 'source'));
    await writeFile(path.join(outside, 'private.txt'), 'PRIVATE_SENTINEL');
    await symlink(outside, path.join(root, 'source', 'escape'));
    const bundle = await extractContext(root, [{ id: 'app', path: 'source' }]);
    expect(bundle.passages).toEqual([]);
    expect(bundle.warnings.join('\n')).toContain('symlink');
  });
  it('rejects explicit credential-file links visibly', async () => {
    const root = await temporary();
    await writeFile(path.join(root, '.env'), 'PASSWORD=PRIVATE');
    const bundle = await extractContext(root, [{ id: 'secret', path: '.env' }]);
    expect(bundle.passages).toEqual([]);
    expect(bundle.warnings.join()).toContain('excluded');
    await mkdir(path.join(root, '.provenarium', 'auth'), { recursive: true });
    await writeFile(
      path.join(root, '.provenarium', 'auth', 'operator.json'),
      '{"cookies":[{"value":"PRIVATE_SESSION"}]}',
    );
    const auth = await extractContext(root, [
      { id: 'auth', path: '.provenarium/auth/operator.json' },
    ]);
    expect(auth.passages).toEqual([]);
    expect(auth.warnings.join()).toContain('excluded');
  });
  it('honors selected source subsets and rejects unknown selections', async () => {
    const root = await temporary();
    await writeFile(path.join(root, 'a.md'), 'A');
    await writeFile(path.join(root, 'b.md'), 'B');
    const sources = [
      { id: 'a', path: 'a.md' },
      { id: 'b', path: 'b.md' },
    ];
    const bundle = await extractContext(root, sources, ['a']);
    expect(bundle.passages.map((x) => x.source)).toEqual(['a']);
    await expect(extractContext(root, sources, ['missing'])).rejects.toThrow(/does not exist/);
  });
  it('extracts HTTPS HTML without script/hidden/password values or redirects', async () => {
    const transport = vi.fn(async (_url: unknown, options?: RequestInit) => {
      expect(options?.redirect).toBe('error');
      return new Response(
        '<html><body><h1>Policy</h1><table><tr><td>Operator</td><td>Read</td></tr></table><script>SECRET_SCRIPT</script><input type="hidden" value="HIDDEN_SECRET"><input type="password" value="PASSWORD_SECRET"></body></html>',
        { headers: { 'content-type': 'text/html' } },
      );
    });
    const bundle = await extractContext(
      '/tmp',
      [{ id: 'policy', url: 'https://example.com/policy' }],
      undefined,
      { fetchImpl: transport as typeof fetch },
    );
    expect(bundle.passages[0].text).toContain('Operator | Read');
    expect(JSON.stringify(bundle)).not.toMatch(/SECRET/);
  });
  it('refuses credential-bearing URLs before sending network requests', async () => {
    const transport = vi.fn();
    const bundle = await extractContext(
      '/tmp',
      [{ id: 'bad', url: 'https://example.com/?token=PRIVATE' }],
      undefined,
      { fetchImpl: transport },
    );
    expect(transport).not.toHaveBeenCalled();
    expect(bundle.warnings.join()).toMatch(/authentication/);
    expect(JSON.stringify(bundle)).not.toContain('PRIVATE');
  });
  it('redacts credentials while leaving ordinary requirements readable', () => {
    expect(
      redact('password="private"; api_key=sk-example01234567890; credential VALUE', ['VALUE']),
    ).not.toMatch(/private|sk-example|VALUE/);
    expect(redact('Passwords must be at least twelve characters.')).toContain('twelve');
  });
});
