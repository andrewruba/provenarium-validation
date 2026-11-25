#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(repository, 'examples', 'dilution-pages');

export async function buildPages({ output = join(repository, '_site'), commit } = {}) {
  commit ??= process.env.GITHUB_SHA;
  commit ??= execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim();
  if (!/^[a-f0-9]{40}$/i.test(commit)) throw new Error('Pages build needs a full Git commit SHA.');
  const directory = resolve(output);
  // Only the generated default directory is removed; callers can use a fresh custom directory.
  if (directory === join(repository, '_site'))
    await rm(directory, { recursive: true, force: true });
  await mkdir(join(directory, 'assets'), { recursive: true });
  for (const file of ['app.js', 'styles.css'])
    await cp(join(source, file), join(directory, 'assets', file));
  const template = await readFile(join(source, 'app.html'), 'utf8');
  const modes = ['correct', 'faulty'];
  for (const mode of modes) {
    await mkdir(join(directory, mode), { recursive: true });
    await writeFile(
      join(directory, mode, 'index.html'),
      template.replaceAll('{{MODE}}', mode).replaceAll('{{COMMIT}}', commit),
    );
    await writeFile(
      join(directory, mode, 'version.json'),
      `${JSON.stringify({ application: 'Dilution Bench', mode, commit }, null, 2)}\n`,
    );
  }
  const landing = (await readFile(join(source, 'index.html'), 'utf8')).replaceAll(
    '{{COMMIT}}',
    commit,
  );
  await writeFile(join(directory, 'index.html'), landing);
  await writeFile(
    join(directory, 'version.json'),
    `${JSON.stringify({ application: 'Dilution Bench', commit, modes }, null, 2)}\n`,
  );
  await writeFile(join(directory, '.nojekyll'), '');
  return { directory, commit, modes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await buildPages();
  console.log(`Static dilution demos built at ${result.directory} (${result.commit}).`);
}
