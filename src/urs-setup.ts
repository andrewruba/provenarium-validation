import { text } from '@clack/prompts';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { loadProject, saveProject } from './project.js';
import { contextSourceSchema, type ContextSource } from './schema.js';
import { safeUrl } from './authoring/security.js';

function answer(value: string | symbol): string {
  if (typeof value === 'symbol') throw new Error('Cancelled.');
  return value.trim();
}

function sourceIdentity(directory: string, source: Pick<ContextSource, 'url' | 'path'>) {
  return source.url ? new URL(source.url).href : path.resolve(directory, source.path!);
}

async function contextLocation(directory: string, location: string) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(location)) {
    const url = safeUrl(location);
    if (url.protocol !== 'https:') throw new Error('Context pages must use HTTPS.');
    return { url: location };
  }
  const info = await lstat(path.resolve(directory, location)).catch(() => {
    throw new Error('Context path not found. Paths are relative to the validation project.');
  });
  if (!info.isFile() && !info.isDirectory())
    throw new Error('Link a regular file or directory directly, not a symlink.');
  return { path: location };
}

export interface UrsInputOptions {
  locations?: string[];
  url?: string;
  interactive?: boolean;
}

/** Collect concrete inputs before authoring; never interview the user about the app. */
export async function prepareUrsInputs(
  directory: string,
  options: UrsInputOptions = {},
): Promise<{ url?: string }> {
  const project = await loadProject(directory);
  let changed = false;
  const add = async (location: string) => {
    if (!location.trim()) throw new Error('Context location cannot be empty.');
    const source = await contextLocation(directory, location.trim());
    const identity = sourceIdentity(directory, source);
    if (project.context.some((existing) => sourceIdentity(directory, existing) === identity))
      return;
    let sequence = 1;
    while (project.context.some((existing) => existing.id === `source-${sequence}`)) sequence++;
    project.context.push(contextSourceSchema.parse({ id: `source-${sequence}`, ...source }));
    changed = true;
  };
  for (const location of options.locations ?? []) await add(location);

  let url = options.url ?? project.target_url;
  const explicit = options.locations?.length || options.url !== undefined;
  if (options.interactive && !explicit) {
    console.log(
      'Add the application source or documents and its deployed URL. AI will read them and draft the requirements; any unresolved decisions will appear as specific questions.',
    );
    if (project.context.length)
      console.log(
        `Using linked context:\n${project.context.map((source) => `  ${source.path ?? source.url}`).join('\n')}`,
      );
    while (true) {
      const location = answer(
        await text({
          message: project.context.length
            ? 'Add more context (file, folder, or HTTPS URL; Enter to continue)'
            : 'Application source or document (path or HTTPS URL; Enter to skip)',
          placeholder: '../my-app',
          validate: async (value) => {
            if (!value?.trim()) return;
            try {
              await contextLocation(directory, value.trim());
            } catch (error) {
              return error instanceof Error ? error.message : 'Enter a readable context location.';
            }
          },
        }),
      );
      if (!location) break;
      await add(location);
    }
    url = answer(
      await text({
        message: 'Deployed application URL',
        initialValue: url,
        placeholder: 'https://app.example.com',
        validate: (value) => {
          if (!value?.trim())
            return project.context.length
              ? undefined
              : 'Provide an application URL or add context.';
          try {
            safeUrl(value.trim());
          } catch {
            return 'Enter an HTTP(S) application URL without credentials.';
          }
        },
      }),
    );
  }
  url = url?.trim() || undefined;
  if (url) safeUrl(url);
  if (!project.context.length && !url)
    throw new Error(
      'Add application context with --context <path> or provide --url <application-url> to draft requirements.',
    );
  if (url !== project.target_url) {
    project.target_url = url;
    changed = true;
  }
  if (changed) await saveProject(directory, project);
  return { url };
}
