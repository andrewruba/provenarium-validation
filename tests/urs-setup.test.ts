import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { text } from '@clack/prompts';
import { loadProject, saveProject } from '../src/project.js';
import { prepareUrsInputs, projectCommand } from '../src/urs-setup.js';

vi.mock('@clack/prompts', () => ({ text: vi.fn() }));

const directories: string[] = [];
const input = vi.mocked(text);

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'provenarium URS setup '));
  directories.push(directory);
  return directory;
}

it('accepts context and the deployed URL without an interview or filename prompts', async () => {
  const directory = await fixture();
  await mkdir(join(directory, 'my app'));
  await writeFile(join(directory, 'design notes.md'), 'Intended behavior');
  await writeFile(join(directory, 'urs.yaml'), 'Existing human requirements\n');

  expect(
    await prepareUrsInputs(directory, {
      locations: ['./my app', './design notes.md'],
      url: 'https://app.example.com',
      interactive: true,
    }),
  ).toEqual({ url: 'https://app.example.com' });
  const project = await loadProject(directory);
  expect(project.context.map((source) => resolve(directory, source.path!))).toEqual([
    join(directory, 'my app'),
    join(directory, 'design notes.md'),
  ]);
  expect(project.target_url).toBe('https://app.example.com');
  expect(input).not.toHaveBeenCalled();
  expect(await readFile(join(directory, 'urs.yaml'), 'utf8')).toBe('Existing human requirements\n');
});

it('allows an application URL by itself, including local development servers', async () => {
  const directory = await fixture();
  expect(
    await prepareUrsInputs(directory, { url: 'http://localhost:4173', interactive: true }),
  ).toEqual({ url: 'http://localhost:4173' });
  expect((await loadProject(directory)).context).toEqual([]);
  expect(input).not.toHaveBeenCalled();
});

it('allows context alone when the application is not deployed yet', async () => {
  const directory = await fixture();
  await writeFile(join(directory, 'design.md'), 'Independent expected behavior');
  expect(
    await prepareUrsInputs(directory, { locations: ['design.md'], interactive: true }),
  ).toEqual({ url: undefined });
  expect((await loadProject(directory)).context).toHaveLength(1);
  expect(input).not.toHaveBeenCalled();
});

it('accepts an optional brief without requiring additional prompts or context', async () => {
  const directory = await fixture();
  expect(await prepareUrsInputs(directory, { hasBrief: true, interactive: true })).toEqual({
    url: undefined,
  });
  expect(input).not.toHaveBeenCalled();
  expect((await loadProject(directory)).context).toEqual([]);
});

it('reuses linked context and the saved application URL in scripted authoring', async () => {
  const directory = await fixture();
  const project = await loadProject(directory);
  project.context = [{ id: 'design', url: 'https://example.com/design', description: 'Reviewed' }];
  project.target_url = 'https://app.example.com';
  project.provider = 'openai';
  await saveProject(directory, project);
  const savedProject = await readFile(join(directory, 'provenarium.yaml'), 'utf8');

  expect(await prepareUrsInputs(directory, { interactive: false })).toEqual({
    url: project.target_url,
  });
  expect(await readFile(join(directory, 'provenarium.yaml'), 'utf8')).toBe(savedProject);
  expect(input).not.toHaveBeenCalled();
});

it('deduplicates context locations and preserves existing source names', async () => {
  const directory = await fixture();
  await writeFile(join(directory, 'design.md'), 'Known requirements');
  await writeFile(join(directory, 'new.md'), 'Additional context');
  const project = await loadProject(directory);
  project.context = [
    { id: 'source-1', path: './design.md', description: 'Keep this source identity' },
    { id: 'reference', url: 'https://example.com/' },
  ];
  await saveProject(directory, project);

  await prepareUrsInputs(directory, {
    locations: [
      'design.md',
      join(directory, 'design.md'),
      'https://example.com',
      'new.md',
      './new.md',
    ],
  });
  const saved = await loadProject(directory);
  expect(saved.context).toHaveLength(3);
  expect(saved.context.slice(0, 2)).toEqual(project.context);
  expect(saved.context[2].id).toBe('source-2');
  expect(resolve(directory, saved.context[2].path!)).toBe(join(directory, 'new.md'));
});

it('guided setup asks only for context locations and the deployed URL', async () => {
  const directory = await fixture();
  await writeFile(join(directory, 'design.md'), 'Known requirements');
  input
    .mockResolvedValueOnce('design.md')
    .mockResolvedValueOnce('')
    .mockResolvedValueOnce('https://app.example.com');

  expect(await prepareUrsInputs(directory, { interactive: true })).toEqual({
    url: 'https://app.example.com',
  });
  expect(input).toHaveBeenCalledTimes(3);
  expect(input.mock.calls[0][0].message).toMatch(/context|source|document/i);
  expect(input.mock.calls[1][0].message).toMatch(/context/i);
  expect(input.mock.calls[2][0].message).toMatch(/url/i);
  const project = await loadProject(directory);
  expect(project.context).toHaveLength(1);
  expect(project.target_url).toBe('https://app.example.com');
});

it('guided setup lets the user skip context and supply only the deployed URL', async () => {
  const directory = await fixture();
  input.mockResolvedValueOnce('').mockResolvedValueOnce('https://app.example.com');

  expect(await prepareUrsInputs(directory, { interactive: true })).toEqual({
    url: 'https://app.example.com',
  });
  expect((await loadProject(directory)).context).toEqual([]);
});

it('guided setup can draft from context when the deployed URL is left blank', async () => {
  const directory = await fixture();
  await writeFile(join(directory, 'design.md'), 'Requirements for an undeployed application');
  input.mockResolvedValueOnce('design.md').mockResolvedValueOnce('').mockResolvedValueOnce('');

  expect(await prepareUrsInputs(directory, { interactive: true })).toEqual({ url: undefined });
  expect((await loadProject(directory)).context).toHaveLength(1);
  const validate = input.mock.calls[2][0].validate!;
  expect(await validate('')).toBeUndefined();
});

it('clears the saved application URL when guided setup leaves the prefilled URL blank', async () => {
  const directory = await fixture();
  const project = await loadProject(directory);
  project.context = [{ id: 'design', url: 'https://example.com/design' }];
  project.target_url = 'https://old-app.example.com';
  await saveProject(directory, project);
  input.mockResolvedValueOnce('').mockResolvedValueOnce('');

  expect(await prepareUrsInputs(directory, { interactive: true })).toEqual({ url: undefined });
  expect(input.mock.calls[1][0].initialValue).toBe(project.target_url);
  const saved = await loadProject(directory);
  expect(saved.target_url).toBeUndefined();
  expect(saved.context).toEqual(project.context);
  expect(await prepareUrsInputs(directory, { interactive: false })).toEqual({ url: undefined });
  expect(input).toHaveBeenCalledTimes(2);
});

it('does not persist pending context when the URL prompt is cancelled', async () => {
  const directory = await fixture();
  const project = await loadProject(directory);
  project.context = [{ id: 'prior', url: 'https://example.com/prior' }];
  project.target_url = 'https://previous.example.com';
  await saveProject(directory, project);
  const savedProject = await readFile(join(directory, 'provenarium.yaml'), 'utf8');
  await writeFile(join(directory, 'new.md'), 'Pending context');
  input
    .mockResolvedValueOnce('new.md')
    .mockResolvedValueOnce('')
    .mockResolvedValueOnce(Symbol('cancel'));

  await expect(prepareUrsInputs(directory, { interactive: true })).rejects.toThrow(/Cancelled/);
  expect(input.mock.calls[2][0].initialValue).toBe(project.target_url);
  expect(await readFile(join(directory, 'provenarium.yaml'), 'utf8')).toBe(savedProject);
});

it('rejects empty scripted input before drafting instead of starting an interview', async () => {
  const directory = await fixture();
  await expect(prepareUrsInputs(directory, { interactive: false })).rejects.toThrow(
    /context|url|source/i,
  );
  expect(input).not.toHaveBeenCalled();
  await expect(readFile(join(directory, 'provenarium.yaml'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it.each(['missing.md', 'http://example.com/design', 'ftp://example.com/design', 'https://'])(
  'rejects unusable context %s without saving partial links',
  async (location) => {
    const directory = await fixture();
    await writeFile(join(directory, 'valid.md'), 'Do not save until all input is valid');
    await expect(
      prepareUrsInputs(directory, {
        locations: ['valid.md', location],
        url: 'https://app.example.com',
      }),
    ).rejects.toThrow();
    await expect(readFile(join(directory, 'provenarium.yaml'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(input).not.toHaveBeenCalled();
  },
);

it.each(['ftp://example.com', 'https://user:password@example.com', 'not-a-url'])(
  'rejects invalid or credential-bearing application URL %s before persisting inputs',
  async (url) => {
    const directory = await fixture();
    await expect(prepareUrsInputs(directory, { url })).rejects.toThrow();
    await expect(readFile(join(directory, 'provenarium.yaml'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(input).not.toHaveBeenCalled();
  },
);

it('prints commands that preserve the project and literal filenames through a shell', async () => {
  const directory = await fixture();
  const bin = join(directory, 'bin');
  await mkdir(bin);
  await writeFile(
    join(bin, 'provenarium'),
    `#!/bin/sh\nexec "$URS_SETUP_TEST_NODE" -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$@"\n`,
    { mode: 0o700 },
  );
  const project = join(directory, "site's $(printf injected) project");
  const args = ['urs', 'check', "patient's $(printf injected) requirements.yaml"];
  const parseCommand = (command: string) =>
    JSON.parse(
      execFileSync('/bin/sh', ['-c', command], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          URS_SETUP_TEST_NODE: process.execPath,
        },
      }),
    );

  expect(parseCommand(projectCommand(project, args))).toEqual(['--project', project, ...args]);
  expect(parseCommand(projectCommand(process.cwd(), args))).toEqual(args);
});
