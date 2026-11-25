import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
// @ts-expect-error Release preparation uses the dependency-free script shipped to CI.
import {
  prepareRelease,
  validateReleaseIdentity,
  verifyRelease,
} from '../scripts/prepare-release.mjs';

const workspaces: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(workspaces.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'provenarium release test '));
  workspaces.push(directory);
  const root = join(directory, 'source checkout');
  const output = join(directory, 'release output');
  await mkdir(join(root, 'docs', 'releases'), { recursive: true });
  await mkdir(join(root, 'bin'));
  await mkdir(join(root, 'dist'));
  const packageInfo = {
    name: 'provenarium-validation',
    version: '0.1.0',
    engines: { node: '>=26 <27' },
    files: ['bin', 'dist', 'docs', 'LICENSE', 'npm-shrinkwrap.json'],
    scripts: { build: 'node --version' },
  };
  await writeFile(join(root, 'package.json'), JSON.stringify(packageInfo));
  vi.stubEnv('npm_config_cache', join(directory, 'npm cache'));
  await writeFile(
    join(root, 'npm-shrinkwrap.json'),
    JSON.stringify({ version: '0.1.0', packages: { '': { version: '0.1.0' } } }),
  );
  await writeFile(join(root, 'docs', 'releases', 'v0.1.0.md'), '# Test release\n');
  await writeFile(join(root, 'bin', 'provenarium.mjs'), '#!/usr/bin/env node\n');
  await writeFile(join(root, 'dist', 'cli.js'), '// compiled CLI fixture\n');
  await writeFile(join(root, 'dist', 'index.js'), '// compiled library fixture\n');
  await writeFile(join(root, 'LICENSE'), 'Synthetic test fixture\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '--quiet');
  git('add', '.');
  git(
    '-c',
    'user.name=Release Test',
    '-c',
    'user.email=test@users.noreply.github.com',
    'commit',
    '--quiet',
    '-m',
    'Fixture',
  );
  return { root, output, commit: git('rev-parse', 'HEAD').trim() };
}

test('rejects mismatched tags, unsafe versions, and noncommit source identifiers', () => {
  const identity = {
    name: 'provenarium-validation',
    version: '0.1.0',
    tag: 'v0.1.0',
    commit: 'a'.repeat(40),
  };
  expect(() => validateReleaseIdentity(identity)).not.toThrow();
  expect(() => validateReleaseIdentity({ ...identity, tag: 'v0.2.0' })).toThrow(/exactly match/);
  expect(() => validateReleaseIdentity({ ...identity, version: '../outside' })).toThrow(
    /Invalid release version/,
  );
  expect(() => validateReleaseIdentity({ ...identity, commit: 'main' })).toThrow(/full Git commit/);
});

test('packs one immutable archive and detects archive tampering or extra assets', async () => {
  const options = await fixture();
  const result = await prepareRelease({ ...options, tag: 'v0.1.0' });
  const archive = await readFile(join(options.output, result.archive.filename));
  const expectedHash = createHash('sha256').update(archive).digest('hex');
  expect(result.archive.sha256).toBe(expectedHash);
  expect(await readFile(join(options.output, 'SHA256SUMS'), 'utf8')).toBe(
    `${expectedHash}  ${result.archive.filename}\n`,
  );
  expect(
    (await verifyRelease(options.output, { tag: 'v0.1.0', commit: options.commit })).commit,
  ).toBe(options.commit);
  await expect(prepareRelease({ ...options, tag: 'v0.1.0' })).rejects.toThrow(/EEXIST/);
  await expect(verifyRelease(options.output, { commit: 'f'.repeat(40) })).rejects.toThrow(
    /Unexpected source/,
  );
  await writeFile(join(options.output, 'unexpected.txt'), 'extra');
  await expect(verifyRelease(options.output)).rejects.toThrow(/unexpected assets/);
  await rm(join(options.output, 'unexpected.txt'));
  archive[archive.length - 1] ^= 1;
  await writeFile(join(options.output, result.archive.filename), archive);
  await expect(verifyRelease(options.output)).rejects.toThrow(/checksum changed/);
});

test('refuses uncommitted source and inconsistent lockfile versions before packaging', async () => {
  const options = await fixture();
  await writeFile(join(options.root, 'untracked.txt'), 'unfinished source');
  await expect(prepareRelease(options)).rejects.toThrow(/clean source checkout/);
  await rm(join(options.root, 'untracked.txt'));
  await writeFile(join(options.root, 'npm-shrinkwrap.json'), JSON.stringify({ version: '0.2.0' }));
  await expect(prepareRelease(options)).rejects.toThrow(/Lockfile version differs/);
});
