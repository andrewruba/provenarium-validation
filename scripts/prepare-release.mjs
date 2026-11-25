#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageName = 'provenarium-validation';
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const assets = (archive) => [archive, 'INSTALL.md', 'RELEASE_NOTES.md', 'release.json'].sort();

export function validateReleaseIdentity({ name, version, tag, commit }) {
  assert.equal(name, packageName, 'Unexpected package name.');
  assert.ok(
    typeof version === 'string' && versionPattern.test(version),
    'Invalid release version.',
  );
  assert.equal(tag, `v${version}`, 'Release tag must exactly match the package version.');
  assert.match(commit, /^[a-f0-9]{40}$/, 'Release source must be a full Git commit SHA.');
}

export async function verifyRelease(directory, { tag, commit } = {}) {
  directory = resolve(directory);
  const manifest = JSON.parse(await readFile(join(directory, 'release.json'), 'utf8'));
  assert.equal(manifest.schema_version, 1, 'Unsupported release manifest.');
  validateReleaseIdentity(manifest);
  if (tag !== undefined) assert.equal(manifest.tag, tag, 'Unexpected release tag.');
  if (commit !== undefined) assert.equal(manifest.commit, commit, 'Unexpected source revision.');
  const filename = `${packageName}-${manifest.version}.tgz`;
  assert.equal(manifest.archive.filename, filename, 'Unexpected release archive filename.');
  const names = assets(filename);
  assert.deepEqual(
    (await readdir(directory)).sort(),
    [...names, 'SHA256SUMS'].sort(),
    'Release directory contains missing or unexpected assets.',
  );
  const bytes = await readFile(join(directory, filename));
  const checksum = hash(bytes);
  assert.equal(bytes.length, manifest.archive.size, 'Release archive size changed.');
  assert.equal(checksum, manifest.archive.sha256, 'Release archive checksum changed.');
  assert.equal(
    await readFile(join(directory, 'SHA256SUMS'), 'utf8'),
    `${checksum}  ${filename}\n`,
    'Release asset checksums changed.',
  );
  return manifest;
}

export async function prepareRelease({
  root = repository,
  output = join(root, 'release-assets'),
  tag,
  commit,
  githubRepository = process.env.GITHUB_REPOSITORY ?? 'andrewruba/provenarium-validation',
} = {}) {
  root = resolve(root);
  output = resolve(output);
  const run = (command, args) =>
    execFileSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const packageInfo = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const lockfile = JSON.parse(await readFile(join(root, 'npm-shrinkwrap.json'), 'utf8'));
  const sourceCommit = run('git', ['rev-parse', 'HEAD']).trim();
  tag ??= `v${packageInfo.version}`;
  validateReleaseIdentity({ ...packageInfo, tag, commit: sourceCommit });
  if (commit !== undefined)
    assert.equal(sourceCommit, commit, 'Checkout is not the requested commit.');
  assert.match(
    githubRepository,
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
    'Invalid GitHub repository.',
  );
  assert.equal(lockfile.version, packageInfo.version, 'Lockfile version differs from the package.');
  assert.equal(
    lockfile.packages?.['']?.version,
    packageInfo.version,
    'Lockfile root version differs.',
  );
  assert.equal(
    run('git', ['status', '--porcelain', '--untracked-files=normal']).trim(),
    '',
    'Release preparation requires a clean source checkout.',
  );
  const notes = await readFile(join(root, 'docs', 'releases', `${tag}.md`), 'utf8');
  assert.ok(notes.trim(), 'Release notes must not be empty.');
  // Refuse to overwrite a previous build, including one awaiting qualification.
  await mkdir(output);
  run('npm', ['run', 'build']);
  const records = JSON.parse(
    run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', output]),
  );
  assert.equal(records.length, 1, 'Expected one installable package.');
  const packed = records[0];
  assert.equal(packed.name, packageInfo.name);
  assert.equal(packed.version, packageInfo.version);
  const filename = `${packageName}-${packageInfo.version}.tgz`;
  assert.equal(packed.filename, filename);
  for (const file of [
    'bin/provenarium.mjs',
    'dist/cli.js',
    'dist/index.js',
    'LICENSE',
    'npm-shrinkwrap.json',
  ]) {
    assert.ok(
      packed.files.some((entry) => entry.path === file),
      `Missing package file: ${file}`,
    );
  }
  assert.equal(
    run('git', ['diff', '--name-only', 'HEAD']).trim(),
    '',
    'Build changed source files.',
  );
  const archive = await readFile(join(output, filename));
  const manifest = {
    schema_version: 1,
    name: packageInfo.name,
    version: packageInfo.version,
    tag,
    commit: sourceCommit,
    repository: githubRepository,
    node: packageInfo.engines.node,
    platforms: ['darwin', 'linux'],
    prerelease: true,
    archive: { filename, sha256: hash(archive), size: archive.length },
  };
  const download = `https://github.com/${githubRepository}/releases/download/${tag}`;
  const installation = `# Install Provenarium Validation ${packageInfo.version}

This npm package archive supports macOS and Linux with Node.js 26 and npm.
Dependencies are downloaded by npm during installation. Chromium is installed
separately. Download the named .tgz asset, not GitHub's source-code archives.

Download the .tgz asset and SHA256SUMS into one directory and verify the archive:

\`\`\`sh
shasum -a 256 -c SHA256SUMS
npm install --global ./${filename}
provenarium --version
provenarium browser install
\`\`\`

On Linux, \`sha256sum -c SHA256SUMS\` can also verify the files. The archive URL is
${download}/${filename}.

To uninstall the global CLI, run \`provenarium uninstall\`. Use
\`provenarium uninstall --yes\` for an unattended removal. The fallback is
\`npm uninstall --global ${packageName}\` using the same npm installation/prefix.
Validation projects, stored credentials, and shared browser caches are retained.
Remove stored provider keys first with \`provenarium auth forget --provider openai\`
and \`provenarium auth forget --provider anthropic\` if desired.

This is a prerelease. Live-provider authoring-quality evaluations remain pending.
See RELEASE_NOTES.md and the packaged installation guide for usage and limits.
Source commit: ${sourceCommit}
`;
  await writeFile(join(output, 'INSTALL.md'), installation);
  await writeFile(join(output, 'RELEASE_NOTES.md'), notes);
  await writeFile(join(output, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(output, 'SHA256SUMS'), `${hash(archive)}  ${filename}\n`);
  await verifyRelease(output, { tag, commit: sourceCommit });
  return { directory: output, ...manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({
      options: {
        tag: { type: 'string' },
        commit: { type: 'string' },
        output: { type: 'string' },
        verify: { type: 'boolean', default: false },
      },
    });
    const result = values.verify
      ? await verifyRelease(values.output ?? join(repository, 'release-assets'), values)
      : await prepareRelease(values);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
