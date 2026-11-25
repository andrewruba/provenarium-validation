#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const example = join(repository, 'examples', 'dilution-pages-validation');
const digest = (value) => createHash('sha256').update(value).digest('hex');

/** Preserve the Pages project and variant path while refusing credentials or caller-supplied state. */
export function variantUrl(value) {
  if (typeof value !== 'string' || !value || value !== value.trim())
    throw new Error('Supply a service URL such as https://example.github.io/project/correct/.');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Service URL is invalid.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new Error('Service URL must use HTTPS; HTTP is supported only for loopback testing.');
  if (url.username || url.password || url.search || url.hash || /[%\\]/.test(url.pathname))
    throw new Error(
      'Supply a variant directory URL without credentials, encoded paths, query, or fragment.',
    );
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

export async function preparePagesDilution({ url, project, workspace = randomUUID() }) {
  const base = variantUrl(url);
  const origin = new URL(base).origin;
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(workspace))
    throw new Error(
      'Workspace ID must contain 8 to 80 ASCII letters, digits, underscores, or hyphens.',
    );
  if (typeof project !== 'string' || !project.trim())
    throw new Error('A new project directory is required.');
  const directory = resolve(project);
  const sourceBytes = await readFile(join(example, 'plan.json'));
  const ursBytes = await readFile(join(example, 'urs.yaml'));
  const plan = JSON.parse(sourceBytes.toString('utf8'));
  const sourceTarget = new URL(plan.target.url);
  const destination = new URL(base);
  destination.searchParams.set('workspace', workspace);
  for (const item of plan.cases) {
    for (const step of item.steps) {
      for (const action of step.actions) {
        if (action.op === 'request')
          throw new Error(
            'The Pages protocol must contain only browser actions, not HTTP API checks.',
          );
        if (action.op !== 'navigate') continue;
        const source = new URL(action.url, sourceTarget);
        if (
          source.origin !== sourceTarget.origin ||
          ![sourceTarget.pathname, sourceTarget.pathname + 'version.json'].includes(
            source.pathname,
          ) ||
          source.search
        )
          throw new Error('The supplied browser protocol contains an unsupported navigation URL.');
        const rewritten =
          source.pathname === sourceTarget.pathname
            ? new URL(destination)
            : new URL('version.json', destination);
        rewritten.hash = source.hash;
        action.url = rewritten.href;
      }
    }
  }
  plan.target = { url: destination.href, allowed_origins: [origin] };
  const target = {
    schema_version: 1,
    base_url: base,
    target_url: plan.target.url,
    workspace,
    protocol_source_sha256: digest(sourceBytes),
    requirements_source_sha256: digest(ursBytes),
  };
  await mkdir(dirname(directory), { recursive: true });
  // This claim is exclusive: never overwrite another validation project or its evidence.
  await mkdir(directory);
  try {
    await writeFile(join(directory, 'urs.yaml'), ursBytes);
    await writeFile(join(directory, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
    await writeFile(join(directory, 'target.json'), `${JSON.stringify(target, null, 2)}\n`);
    for (const relative of new Set([...plan.fixtures, ...plan.references])) {
      if (isAbsolute(relative) || relative.split(/[\\/]/).includes('..'))
        throw new Error('The demonstration protocol contains an unsupported fixture path.');
      const destination = join(directory, relative);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, await readFile(join(example, relative)));
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { project: directory, target, plan };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({
      options: {
        url: { type: 'string' },
        project: { type: 'string' },
        workspace: { type: 'string' },
        help: { type: 'boolean' },
      },
    });
    if (values.help) {
      console.log(
        'Usage: node scripts/prepare-pages-dilution.mjs --url <variant-directory-url> --project <new-directory> [--workspace <id>]',
      );
    } else {
      const prepared = await preparePagesDilution(values);
      console.log(
        `Prepared project: ${prepared.project}\nWorkspace: ${prepared.target.target_url}`,
      );
      console.log('No network requests, model calls, or approvals were performed.');
      console.log('Next use the main CLI with --project set to this directory:');
      console.log('  generate --urs urs.yaml --plan plan.json\n  approve\n  run\n  report');
      console.log(
        'Read target.json for the workspace URL. Clear preparations there before repeating a run.',
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
