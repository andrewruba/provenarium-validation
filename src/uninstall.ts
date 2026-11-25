import { confirm } from '@clack/prompts';
import { spawn } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageName = 'provenarium-validation';
const guidance =
  'Use the npm belonging to this installation, or remove a local dependency with npm uninstall provenarium-validation from its owning project. Source checkouts and npm links must be removed separately.';

export interface UninstallOptions {
  yes?: boolean;
  dryRun?: boolean;
  signal?: AbortSignal;
}

/** Runtime overrides let tests exercise real child processes in an isolated prefix. */
export interface UninstallRuntime {
  packageDirectory?: string;
  nodeExecutable?: string;
  npmCli?: string;
  isTTY?: boolean;
  confirm?: () => Promise<boolean | symbol>;
  log?: (message: string) => void;
}

async function present(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Run npm under the same Node executable as this CLI, bypassing launcher shebangs. */
export async function resolveNpmCli(
  nodeExecutable = process.execPath,
  searchPath = process.env.PATH ?? '',
): Promise<string> {
  const launchers = [
    path.join(path.dirname(nodeExecutable), 'npm'),
    ...searchPath
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, 'npm')),
  ];
  for (const launcher of [...new Set(launchers)]) {
    try {
      const executable = await realpath(launcher);
      // npm shims/binaries cannot safely be interpreted as JavaScript or another package manager.
      if (path.basename(executable) !== 'npm-cli.js') continue;
      const manifest = JSON.parse(
        await readFile(path.resolve(executable, '..', '..', 'package.json'), 'utf8'),
      );
      if (manifest.name === 'npm') return executable;
    } catch {
      // Try the next standard npm launcher. Never invoke an unrecognized shim.
    }
  }
  throw new Error(`Cannot locate npm's JavaScript CLI for this Node installation. ${guidance}`);
}

async function runNpm(
  nodeExecutable: string,
  npmCli: string,
  args: string[],
  options: { cwd: string; inherit?: boolean; signal?: AbortSignal },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeExecutable, [npmCli, ...args], {
      cwd: options.cwd,
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      signal: options.signal,
      shell: false,
    });
    let output = '';
    let bytes = 0;
    const collect = (data: Buffer, stdout: boolean) => {
      bytes += data.length;
      if (bytes > 65536) {
        child.kill();
        reject(new Error('npm returned too much output while inspecting the installation.'));
      } else if (stdout) output += data.toString('utf8');
    };
    child.stdout?.on('data', (data: Buffer) => collect(data, true));
    child.stderr?.on('data', (data: Buffer) => collect(data, false));
    child.once('error', (error) => reject(new Error(`Could not run npm: ${error.message}`)));
    child.once('close', (code, signal) => {
      if (code === 0) resolve(output.trim());
      else
        reject(
          new Error(
            `npm ${args[0]} failed (${signal ? `signal ${signal}` : `exit ${code}`}). No elevated retry was attempted. ${guidance}`,
          ),
        );
    });
  });
}

function absoluteOutput(value: string, label: string): string {
  if (!path.isAbsolute(value) || /[\r\n\0]/.test(value))
    throw new Error(`npm returned an invalid ${label}; refusing to uninstall. ${guidance}`);
  return path.resolve(value);
}

export async function uninstall(
  options: UninstallOptions = {},
  runtime: UninstallRuntime = {},
): Promise<void> {
  const packageDirectory = path.resolve(
    runtime.packageDirectory ?? fileURLToPath(new URL('..', import.meta.url)),
  );
  const nodeExecutable = runtime.nodeExecutable ?? process.execPath;
  const log = runtime.log ?? console.log;
  if (
    (await present(path.join(packageDirectory, '.git'))) ||
    (await present(path.join(packageDirectory, 'src', 'cli.ts')))
  )
    throw new Error(`Self-uninstall is unavailable from a source checkout. ${guidance}`);
  const npmCli = runtime.npmCli ?? (await resolveNpmCli(nodeExecutable));
  const inspect = async () => {
    const prefix = absoluteOutput(
      await runNpm(nodeExecutable, npmCli, ['prefix', '--global'], {
        cwd: path.dirname(packageDirectory),
        signal: options.signal,
      }),
      'global prefix',
    );
    const globalRoot = absoluteOutput(
      await runNpm(nodeExecutable, npmCli, ['root', '--global', '--prefix', prefix], {
        cwd: path.dirname(packageDirectory),
        signal: options.signal,
      }),
      'global root',
    );
    const installed = path.join(globalRoot, packageName);
    try {
      const metadata = await lstat(installed);
      const manifest = JSON.parse(
        await readFile(path.join(packageDirectory, 'package.json'), 'utf8'),
      );
      if (
        metadata.isSymbolicLink() ||
        !metadata.isDirectory() ||
        (await realpath(installed)) !== (await realpath(packageDirectory)) ||
        manifest.name !== packageName
      )
        throw new Error('Installation does not match npm global root.');
      return {
        prefix,
        installed,
        identity: `${metadata.dev}:${metadata.ino}`,
        version: manifest.version,
      };
    } catch {
      throw new Error(
        `The running CLI is not this npm's global ${packageName} installation. Refusing to remove a different installation. ${guidance}`,
      );
    }
  };
  const installation = await inspect();
  const args = [
    'uninstall',
    '--global',
    '--prefix',
    installation.prefix,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    packageName,
  ];
  log(`Global installation: ${installation.installed}\nVersion: ${installation.version}`);
  log('Validation projects, saved credentials, and shared browser downloads will be retained.');
  if (options.dryRun) {
    log(
      `Dry run; no changes made.\nCommand arguments: ${JSON.stringify([nodeExecutable, npmCli, ...args])}`,
    );
    return;
  }
  if (!options.yes) {
    if (!(runtime.isTTY ?? process.stdin.isTTY))
      throw new Error(
        'Uninstall needs an interactive terminal or explicit --yes. Use --dry-run to inspect it.',
      );
    const accepted = await (
      runtime.confirm ??
      (() => confirm({ message: 'Uninstall this global CLI?', initialValue: false }))
    )();
    if (accepted !== true) throw new Error('Uninstall cancelled; no changes made.');
  }
  options.signal?.throwIfAborted();
  // Configuration or the installed package may have changed while confirmation was open.
  const current = await inspect();
  if (JSON.stringify(current) !== JSON.stringify(installation))
    throw new Error(
      'The installation changed after inspection; refusing to uninstall. Run the command again.',
    );
  await runNpm(nodeExecutable, npmCli, args, {
    cwd: installation.prefix,
    inherit: true,
    signal: options.signal,
  });
  if (await present(installation.installed))
    throw new Error(
      'npm exited successfully, but the installation is still present. Inspect it before retrying.',
    );
  log('Provenarium CLI uninstalled.');
}
