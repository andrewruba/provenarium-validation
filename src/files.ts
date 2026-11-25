import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument, stringify } from 'yaml';

export function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export async function safePath(root: string, relative: string): Promise<string> {
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.includes('\\') ||
    relative.includes('\0') ||
    relative.split('/').some((p) => p === '..' || p === '.' || !p)
  )
    throw new Error(`Unsafe relative path: ${relative}`);
  const base = path.resolve(root);
  let current = base;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(`Symlink is not allowed: ${relative}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return current;
}
export async function readJson<T = unknown>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}
export async function atomicWrite(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
export async function writeJson(file: string, data: unknown): Promise<void> {
  await atomicWrite(file, JSON.stringify(data, null, 2) + '\n');
}
export async function writeNew(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data, { flag: 'wx', mode: 0o600 });
}
export function parseYaml(text: string): unknown {
  const doc = parseDocument(text, { uniqueKeys: true, strict: true });
  if (doc.errors.length || doc.warnings.length)
    throw new Error(
      `Invalid YAML: ${[...doc.errors, ...doc.warnings].map((e) => e.message).join('; ')}`,
    );
  return doc.toJS({ maxAliasCount: 0 });
}
export async function readYaml(file: string): Promise<unknown> {
  return parseYaml(await readFile(file, 'utf8'));
}
export async function writeYaml(file: string, data: unknown): Promise<void> {
  await atomicWrite(file, stringify(data, { lineWidth: 100 }));
}
export async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}
export async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of (await readdir(path.join(root, prefix), { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symlink is not allowed: ${relative}`);
    if (entry.isDirectory()) result.push(...(await listFiles(root, relative)));
    else if (entry.isFile()) result.push(relative);
  }
  return result;
}
