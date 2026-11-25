import { appendFile, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Observation, Run } from '../schema.js';

export const digest = (bytes: string | Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

export async function containedPath(root: string, relative: string): Promise<string> {
  if (
    !relative ||
    isAbsolute(relative) ||
    relative.includes('\\') ||
    relative.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('A package-relative path must stay inside its package.');
  }
  const base = await realpath(root);
  let current = base;
  for (const component of relative.split('/')) {
    current = join(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink())
        throw new Error('Symlinks are not allowed in approved package paths.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return current;
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function readRun(runDirectory: string): Promise<Run> {
  return JSON.parse(await readFile(join(runDirectory, 'run.json'), 'utf8')) as Run;
}

export async function updateRun(runDirectory: string, update: (run: Run) => void): Promise<Run> {
  const run = await readRun(runDirectory);
  update(run);
  await atomicJson(join(runDirectory, 'run.json'), run);
  return run;
}

export async function appendObservation(
  runDirectory: string,
  observation: Observation,
): Promise<void> {
  await appendFile(
    join(resolve(runDirectory), 'observations.jsonl'),
    `${JSON.stringify(observation)}\n`,
    { mode: 0o600 },
  );
}

export function redactor(secrets: string[]) {
  const values = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  return (value: unknown): unknown => {
    function clean(input: unknown): unknown {
      if (typeof input === 'string') {
        let result = input;
        for (const secret of values) {
          result = result.split(secret).join('[REDACTED]');
          const encoded = encodeURIComponent(secret);
          if (encoded !== secret) result = result.split(encoded).join('[REDACTED]');
        }
        return result;
      }
      if (Array.isArray(input)) return input.map(clean);
      if (input && typeof input === 'object')
        return Object.fromEntries(
          Object.entries(input).map(([key, item]) => [String(clean(key)), clean(item)]),
        );
      return input;
    }
    return clean(value);
  };
}

/** Token-bearing authentication payloads must never become recorded evidence. */
export function secretFieldValues(value: unknown): string[] {
  const found: string[] = [];
  const pending: unknown[] = [value];
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    for (const [key, field] of Object.entries(current)) {
      if (
        typeof field === 'string' &&
        /password|secret|token$|authorization|cookie|session/i.test(key) &&
        field
      )
        found.push(field);
      else if (field && typeof field === 'object') pending.push(field);
    }
  }
  return found;
}

export function variableValue(variables: Map<string, unknown>, selector: string): unknown {
  const [name, ...parts] = selector.split('.');
  let value = variables.get(name);
  if (!variables.has(name)) throw new Error(`Observation variable ${name} was not produced.`);
  for (const part of parts) {
    if (
      ['__proto__', 'constructor', 'prototype'].includes(part) ||
      !value ||
      typeof value !== 'object' ||
      !Object.hasOwn(value, part)
    ) {
      throw new Error(`Observation variable ${selector} has no such field.`);
    }
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

export type WorkerContext = {
  projectRoot: string;
  packageDirectory: string;
  runDirectory: string;
  tests: string[];
  socketPath: string;
};
