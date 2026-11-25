import { afterEach, expect, it } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveNpmCli, uninstall } from '../src/uninstall.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'provenarium uninstall '));
  directories.push(directory);
  const prefix = path.join(directory, 'global prefix');
  const root = path.join(prefix, 'lib', 'node_modules');
  const packageDirectory = path.join(root, 'provenarium-validation');
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    path.join(packageDirectory, 'package.json'),
    JSON.stringify({ name: 'provenarium-validation', version: '0.1.0' }),
  );
  const project = path.join(directory, 'validation project.json');
  await writeFile(project, 'retained evidence');
  const callsFile = path.join(directory, 'npm-calls.jsonl');
  const controlFile = path.join(directory, 'control.json');
  await writeFile(controlFile, '{}');
  const npmCli = path.join(directory, 'npm-cli.cjs');
  await writeFile(
    npmCli,
    `
const fs = require('node:fs');
const args = process.argv.slice(2);
const control = JSON.parse(fs.readFileSync(${JSON.stringify(controlFile)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\\n');
if (args[0] === 'prefix') {
  if (control.failInspect) process.exit(9);
  console.log(control.prefix || ${JSON.stringify(prefix)});
} else if (args[0] === 'root') {
  console.log(${JSON.stringify(root)});
} else if (args[0] === 'uninstall') {
  if (control.failUninstall) process.exit(7);
  if (!control.keepInstalled) fs.rmSync(${JSON.stringify(packageDirectory)}, { recursive: true });
} else process.exit(8);
`,
  );
  const logs: string[] = [];
  const runtime = {
    packageDirectory,
    npmCli,
    isTTY: false,
    log: (message: string) => logs.push(message),
  };
  return {
    directory,
    prefix,
    root,
    packageDirectory,
    npmCli,
    project,
    controlFile,
    runtime,
    logs,
    calls: async () => {
      try {
        return (await readFile(callsFile, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as string[]);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    },
  };
}

it('dry-run inspects the matching global installation with spaces and never removes it', async () => {
  const f = await fixture();
  await uninstall({ dryRun: true }, f.runtime);
  expect(await f.calls()).toEqual([
    ['prefix', '--global'],
    ['root', '--global', '--prefix', f.prefix],
  ]);
  expect(f.logs.join('\n')).toContain('Dry run; no changes made.');
  expect(
    JSON.parse(await readFile(path.join(f.packageDirectory, 'package.json'), 'utf8')).name,
  ).toBe('provenarium-validation');
});

it('requires explicit confirmation in a noninteractive process', async () => {
  const f = await fixture();
  await expect(uninstall({}, f.runtime)).rejects.toThrow('interactive terminal or explicit --yes');
  expect((await f.calls()).some((args) => args[0] === 'uninstall')).toBe(false);
});

it.each([false, Symbol('cancel')])(
  'does not remove anything after a declined or cancelled prompt',
  async (answer) => {
    const f = await fixture();
    await expect(
      uninstall({}, { ...f.runtime, isTTY: true, confirm: async () => answer }),
    ).rejects.toThrow('Uninstall cancelled');
    expect((await f.calls()).some((args) => args[0] === 'uninstall')).toBe(false);
  },
);

it('removes only the verified global package through npm with its exact prefix', async () => {
  const f = await fixture();
  const unrelated = path.join(f.root, 'another-package');
  await mkdir(unrelated);
  await writeFile(path.join(unrelated, 'package.json'), '{}');
  await uninstall({ yes: true }, f.runtime);
  expect((await f.calls()).at(-1)).toEqual([
    'uninstall',
    '--global',
    '--prefix',
    f.prefix,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    'provenarium-validation',
  ]);
  await expect(readFile(path.join(f.packageDirectory, 'package.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(await readFile(f.project, 'utf8')).toBe('retained evidence');
  expect(await readFile(path.join(unrelated, 'package.json'), 'utf8')).toBe('{}');
  expect(f.logs.at(-1)).toBe('Provenarium CLI uninstalled.');
});

it('refuses a source checkout before invoking npm', async () => {
  const f = await fixture();
  await mkdir(path.join(f.packageDirectory, 'src'));
  await writeFile(path.join(f.packageDirectory, 'src', 'cli.ts'), '');
  await expect(uninstall({ yes: true }, f.runtime)).rejects.toThrow('source checkout');
  expect(await f.calls()).toEqual([]);
});

it('refuses local/npx packages when a different global installation exists', async () => {
  const f = await fixture();
  const local = path.join(f.directory, 'other project', 'node_modules', 'provenarium-validation');
  await mkdir(local, { recursive: true });
  await writeFile(
    path.join(local, 'package.json'),
    JSON.stringify({ name: 'provenarium-validation' }),
  );
  await expect(uninstall({ yes: true }, { ...f.runtime, packageDirectory: local })).rejects.toThrow(
    'Refusing to remove a different installation',
  );
  expect((await f.calls()).some((args) => args[0] === 'uninstall')).toBe(false);
  expect(await readFile(path.join(f.packageDirectory, 'package.json'), 'utf8')).toContain(
    'provenarium-validation',
  );
});

it('refuses npm link installations even when the resolved package matches', async () => {
  const f = await fixture();
  const linked = path.join(f.directory, 'linked package');
  await rename(f.packageDirectory, linked);
  await symlink(linked, f.packageDirectory);
  await expect(
    uninstall({ yes: true }, { ...f.runtime, packageDirectory: linked }),
  ).rejects.toThrow('not this npm');
  expect((await f.calls()).some((args) => args[0] === 'uninstall')).toBe(false);
});

it('rechecks installation identity after confirmation and refuses a replacement', async () => {
  const f = await fixture();
  await expect(
    uninstall(
      {},
      {
        ...f.runtime,
        isTTY: true,
        confirm: async () => {
          await rename(f.packageDirectory, path.join(f.directory, 'old package'));
          await mkdir(f.packageDirectory);
          await writeFile(
            path.join(f.packageDirectory, 'package.json'),
            JSON.stringify({ name: 'provenarium-validation', version: '0.1.0' }),
          );
          return true;
        },
      },
    ),
  ).rejects.toThrow('installation changed');
  expect((await f.calls()).some((args) => args[0] === 'uninstall')).toBe(false);
});

it('preserves the installation when npm inspection fails', async () => {
  const f = await fixture();
  await writeFile(f.controlFile, JSON.stringify({ failInspect: true }));
  await expect(uninstall({ yes: true }, f.runtime)).rejects.toThrow('npm prefix failed (exit 9)');
  expect(await f.calls()).toEqual([['prefix', '--global']]);
});

it('reports process startup failure without a removal attempt', async () => {
  const f = await fixture();
  await expect(
    uninstall(
      { yes: true },
      { ...f.runtime, nodeExecutable: path.join(f.directory, 'missing-node') },
    ),
  ).rejects.toThrow('Could not run npm');
  expect(await f.calls()).toEqual([]);
});

it('reports failed npm removal without claiming success', async () => {
  const f = await fixture();
  await writeFile(f.controlFile, JSON.stringify({ failUninstall: true }));
  await expect(uninstall({ yes: true }, f.runtime)).rejects.toThrow(
    'npm uninstall failed (exit 7)',
  );
  expect(f.logs).not.toContain('Provenarium CLI uninstalled.');
  expect(await readFile(path.join(f.packageDirectory, 'package.json'), 'utf8')).toContain(
    'provenarium-validation',
  );
});

it('verifies removal even if npm incorrectly reports success', async () => {
  const f = await fixture();
  await writeFile(f.controlFile, JSON.stringify({ keepInstalled: true }));
  await expect(uninstall({ yes: true }, f.runtime)).rejects.toThrow(
    'installation is still present',
  );
  expect(f.logs).not.toContain('Provenarium CLI uninstalled.');
});

it('honors cancellation before removing an inspected installation', async () => {
  const f = await fixture();
  const abort = new AbortController();
  await expect(
    uninstall(
      { signal: abort.signal },
      {
        ...f.runtime,
        isTTY: true,
        confirm: async () => {
          abort.abort();
          return true;
        },
      },
    ),
  ).rejects.toThrow();
  expect((await f.calls()).some((args) => args[0] === 'uninstall')).toBe(false);
});

it('resolves a standard npm CLI and rejects an unrelated launcher', async () => {
  const f = await fixture();
  const bin = path.join(f.directory, 'bin');
  await mkdir(bin);
  const npm = path.join(f.directory, 'npm', 'bin');
  await mkdir(npm, { recursive: true });
  await writeFile(path.join(npm, '..', 'package.json'), JSON.stringify({ name: 'npm' }));
  await writeFile(path.join(npm, 'npm-cli.js'), '');
  await symlink(path.join(npm, 'npm-cli.js'), path.join(bin, 'npm'));
  expect(await resolveNpmCli(path.join(bin, 'node'), '')).toBe(
    await realpath(path.join(npm, 'npm-cli.js')),
  );
  await rm(path.join(bin, 'npm'));
  await writeFile(path.join(bin, 'npm'), 'unrecognized shim');
  await expect(resolveNpmCli(path.join(bin, 'node'), '')).rejects.toThrow('Cannot locate npm');
});
