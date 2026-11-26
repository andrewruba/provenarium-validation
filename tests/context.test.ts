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
  it('reads the real dilution implementation behind the selected HTML entrypoint', async () => {
    const bundle = await extractContext(process.cwd(), [
      { id: 'app', path: 'examples/dilution-pages/app.html' },
    ]);
    const implementation = bundle.passages.find(
      (item) => item.location === 'examples/dilution-pages/app.js',
    );
    expect(implementation?.text).toContain('Number.isFinite(value)');
    expect(implementation?.text).toContain('localStorage.getItem(key)');
    expect(implementation?.text).toContain('text/csv;charset=utf-8');
    expect(implementation?.text).toContain('value.toFixed(3)');
    expect(bundle.passages[0].text).toContain('[Local HTML source: untrusted implementation text');
    expect(bundle.passages.map((item) => item.location)).toEqual([
      'examples/dilution-pages/app.html',
      'examples/dilution-pages/app.js',
    ]);
    expect(bundle.warnings.join('\n')).toContain(
      'reading same-named local source examples/dilution-pages/app.js instead',
    );
    expect(bundle.hashes.find((item) => item.location === implementation?.location)).toEqual({
      source: 'app',
      location: 'examples/dilution-pages/app.js',
      sha256: createHash('sha256')
        .update(await readFile('examples/dilution-pages/app.js'))
        .digest('hex'),
    });
  });
  it('retains local inline implementation as text without executing it or exposing credential fields', async () => {
    const root = await temporary();
    await writeFile(
      path.join(root, 'app.html'),
      `<html><body>
      <h1>Preparation form</h1><input name="volume" value="10">
      <input type="PASSWORD" value="PASSWORD_PRIVATE">
      <input type="hidden" value="HIDDEN_PRIVATE">
      <textarea name="access-token">TEXTAREA_PRIVATE</textarea>
      <div data-token="ATTRIBUTE_PRIVATE"></div>
      <meta name="csrf-token" content="META_PRIVATE">
      <a href="https://example.test/session?token=QUERY_PRIVATE">Session</a>
      <script>globalThis.__provenariumContextExecuted = true; const password = "INLINE_PRIVATE"; const precision = 3;</script>
    </body></html>`,
    );
    const bundle = await extractContext(root, [{ id: 'app', path: 'app.html' }]);
    expect(bundle.passages[0].text).toContain('const precision = 3');
    expect(bundle.passages[0].text).toContain('name="volume" value="10"');
    expect(bundle.passages[0].text).toContain('Preparation form');
    expect((globalThis as Record<string, unknown>).__provenariumContextExecuted).toBeUndefined();
    expect(JSON.stringify(bundle)).not.toMatch(
      /(?:PASSWORD|HIDDEN|TEXTAREA|ATTRIBUTE|META|QUERY|INLINE)_PRIVATE/,
    );
    expect(bundle.passages[0].text).toContain('[REDACTED]');
  });
  it('follows bounded literal module dependencies, including multiline imports, and deduplicates cycles and directory walking', async () => {
    const root = await temporary();
    await mkdir(path.join(root, 'app'));
    await writeFile(
      path.join(root, 'app', 'index.html'),
      '<script src="./main.mjs"></script><p>App</p>',
    );
    await writeFile(
      path.join(root, 'app', 'main.mjs'),
      'import {\n value\n} from "./shared.js"; export { other } from "./other.js"; import("./dynamic.js");',
    );
    await writeFile(
      path.join(root, 'app', 'shared.js'),
      'import "./main.mjs"; export const value = "SHARED_IMPLEMENTATION";',
    );
    await writeFile(
      path.join(root, 'app', 'other.js'),
      'const dep = require("./shared.js"); export const other = "OTHER_IMPLEMENTATION";',
    );
    await writeFile(
      path.join(root, 'app', 'dynamic.js'),
      'export const value = "DYNAMIC_IMPLEMENTATION";',
    );
    const bundle = await extractContext(root, [{ id: 'app', path: 'app' }]);
    expect(bundle.passages).toHaveLength(5);
    expect(new Set(bundle.passages.map((item) => item.location)).size).toBe(5);
    expect(bundle.hashes).toHaveLength(5);
    expect(bundle.passages.every((item) => item.source === 'app')).toBe(true);
    expect(bundle.passages.map((item) => item.text).join('\n')).toContain('DYNAMIC_IMPLEMENTATION');
  });
  it('does not read outside, remote, symlinked, secret, or dependency-vendor source content', async () => {
    const root = await temporary();
    const app = path.join(root, 'app');
    await mkdir(path.join(app, 'node_modules'), { recursive: true });
    await mkdir(path.join(root, 'outside'));
    await writeFile(path.join(root, 'outside.js'), 'OUTSIDE_PRIVATE');
    await writeFile(path.join(root, 'outside', 'linked.js'), 'SYMLINK_PRIVATE');
    await writeFile(path.join(app, 'credentials.js'), 'CREDENTIAL_PRIVATE');
    await writeFile(path.join(app, '.env.js'), 'ENV_PRIVATE');
    await writeFile(path.join(app, 'node_modules', 'vendor.js'), 'VENDOR_PRIVATE');
    await symlink(path.join(root, 'outside.js'), path.join(app, 'pointer.js'));
    await symlink(path.join(root, 'outside'), path.join(app, 'escape'));
    await writeFile(path.join(app, 'good.js'), 'const behavior = "VALID_IMPLEMENTATION";');
    await writeFile(
      path.join(app, 'index.html'),
      [
        '../outside.js',
        'https://example.test/remote.js',
        '//example.test/another.js',
        './pointer.js',
        './escape/linked.js',
        './credentials.js',
        './.env.js',
        './node_modules/vendor.js',
        './good.js?version=1#module',
      ]
        .map((src) => `<script src="${src}"></script>`)
        .join('\n'),
    );
    const transport = vi.fn();
    const bundle = await extractContext(root, [{ id: 'app', path: 'app/index.html' }], undefined, {
      fetchImpl: transport,
    });
    expect(transport).not.toHaveBeenCalled();
    expect(bundle.passages.map((item) => item.location)).toEqual(['app/index.html', 'app/good.js']);
    expect(JSON.stringify(bundle)).not.toMatch(/(?:OUTSIDE|SYMLINK|CREDENTIAL|ENV|VENDOR)_PRIVATE/);
    expect(bundle.warnings.join('\n')).toContain('outside linked source directory');
    expect(bundle.warnings.join('\n')).toContain('symlink');
  });
  it('uses a sibling source fallback only for a missing build reference, not an existing outside script', async () => {
    const root = await temporary();
    await mkdir(path.join(root, 'app'));
    await mkdir(path.join(root, 'assets'));
    await writeFile(path.join(root, 'assets', 'main.js'), 'OUTSIDE_BUILD_PRIVATE');
    await writeFile(path.join(root, 'app', 'main.js'), 'UNRELATED_SIBLING_PRIVATE');
    await writeFile(path.join(root, 'app', 'other.js'), 'MATCHING_SOURCE_IMPLEMENTATION');
    await writeFile(
      path.join(root, 'app', 'index.html'),
      '<script src="../assets/main.js"></script><script src="./build/other.js"></script>',
    );
    const bundle = await extractContext(root, [{ id: 'app', path: 'app/index.html' }]);
    expect(bundle.passages.map((item) => item.location)).toEqual([
      'app/index.html',
      'app/other.js',
    ]);
    expect(JSON.stringify(bundle)).not.toContain('OUTSIDE_BUILD_PRIVATE');
    expect(JSON.stringify(bundle)).not.toContain('UNRELATED_SIBLING_PRIVATE');
    expect(bundle.warnings.join('\n')).toContain('same-named local source app/other.js');
  });
  it('shares extraction limits with companion dependencies and bounds dependency depth', async () => {
    const root = await temporary();
    await writeFile(
      path.join(root, 'index.html'),
      '<script src="./module0.js"></script><p>App</p>',
    );
    for (let index = 0; index < 20; index++)
      await writeFile(
        path.join(root, `module${index}.js`),
        `import "./module${index + 1}.js"; const value = ${index};`,
      );
    const oneFile = await extractContext(root, [{ id: 'app', path: 'index.html' }], undefined, {
      maxFiles: 1,
    });
    expect(oneFile.passages).toHaveLength(1);
    expect(oneFile.warnings.join('\n')).toContain('context limit');
    const fewCharacters = await extractContext(
      root,
      [{ id: 'app', path: 'index.html' }],
      undefined,
      { maxCharacters: 100 },
    );
    expect(fewCharacters.passages.reduce((total, item) => total + item.text.length, 0)).toBe(100);
    expect(fewCharacters.passages).toHaveLength(1);
    const depth = await extractContext(root, [{ id: 'app', path: 'index.html' }]);
    expect(depth.passages).toHaveLength(13);
    expect(depth.warnings.join('\n')).toContain('depth limit');
  });
  it('retains later readable dependencies when an earlier one is missing', async () => {
    const root = await temporary();
    await writeFile(path.join(root, 'main.js'), 'import "./missing.js"; import "./present.js";');
    await writeFile(
      path.join(root, 'present.js'),
      'export const actual = "PRESENT_IMPLEMENTATION";',
    );
    const bundle = await extractContext(root, [{ id: 'app', path: 'main.js' }]);
    expect(bundle.passages.map((item) => item.location)).toEqual(['main.js', 'present.js']);
    expect(bundle.warnings.join('\n')).toContain('missing.js was not found');
  });
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
