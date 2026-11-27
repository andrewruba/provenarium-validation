import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const example = join(repository, 'examples', 'dilution-validation');
const digest = (value) => createHash('sha256').update(value).digest('hex');

/** Accept a service origin, never credentials or a workspace selected by someone else. */
export function serviceOrigin(value) {
  if (typeof value !== 'string' || !value || value !== value.trim())
    throw new Error('Supply a service URL such as https://your-service.onrender.com.');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Service URL is invalid.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new Error('Service URL must use HTTPS; HTTP is supported only for loopback testing.');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error(
      'Supply only the service origin, without credentials, path, query, or fragment.',
    );
  return url.origin;
}

export async function prepareDilution({ url, project, workspace = randomUUID() }) {
  const origin = serviceOrigin(url);
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
  const sourceOrigin = new URL(plan.target.url).origin;
  const prefix = `/w/${workspace}`;
  for (const item of plan.cases) {
    for (const step of item.steps) {
      for (const action of step.actions) {
        if (!['navigate', 'request'].includes(action.op)) continue;
        const source = new URL(action.url, plan.target.url);
        if (source.origin !== sourceOrigin || source.search || source.hash)
          throw new Error(
            'The supplied demonstration protocol contains an unsupported target URL.',
          );
        action.url = `${prefix}${source.pathname}`;
      }
    }
  }
  plan.target = { url: `${origin}${prefix}/`, allowed_origins: [origin] };
  const target = {
    schema_version: 1,
    base_url: origin,
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
