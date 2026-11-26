import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import { ursSchema } from '../src/schema.js';
import { loadUrs } from '../src/urs.js';
import { repairUrsReferences } from '../src/urs-reference-repair.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const context = {
  passages: [
    {
      source: 'design',
      location: 'DEFECTS.md',
      text: 'OQ-ZERO-VOLUME: reject zero volume without changing records.',
    },
  ],
  hashes: [],
  warnings: [],
};
const observation = {
  url: 'https://example.test/correct/',
  title: 'Dilution Bench',
  text: 'Before you calculate',
  controls: [],
  links: [],
};
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'provenarium reference repair '));
  roots.push(root);
  const urs = ursSchema.parse({
    schema_version: 1,
    document: {
      id: 'URS-DEMO',
      title: 'Dilution Bench',
      revision: '2',
      intended_use: 'Exercise synthetic dilutions.',
    },
    families: [
      {
        id: 'input',
        title: 'Input validation',
        requirements: [
          {
            id: 'URS-INPUT',
            title: 'Reject invalid volume',
            statement: 'Reject zero volume without changing any records.',
            details: [
              'The previous result must not be presented as a successful result for the rejected input.',
            ],
            references: [
              'OQ-ZERO-VOLUME',
              'Hosted observation: https://example.test/correct/ — Before you calculate',
            ],
          },
        ],
      },
    ],
    open_questions: [
      {
        id: 'Q-TINY',
        requirement: 'URS-INPUT',
        question: 'What should happen when a positive volume displays as zero?',
        answer: 'Show a warning.',
      },
    ],
  });
  const file = path.join(root, 'urs.yaml');
  const raw =
    '# Human note at the top.\n' +
    stringify(urs)
      .replace(
        '        statement:',
        '        # Keep the intended behavior note.\n        statement:',
      )
      .replace(
        '          - OQ-ZERO-VOLUME',
        '          # Keep the provenance note.\n          - OQ-ZERO-VOLUME',
      );
  await writeFile(file, raw);
  return { root, file, urs, raw };
}
function ui() {
  const logs: string[] = [];
  return {
    isTTY: true,
    confirm: vi.fn<(...args: unknown[]) => Promise<boolean | symbol>>().mockResolvedValue(true),
    log: (message: string) => logs.push(message),
    logs,
  };
}

it('previews and repairs provenance formatting while retaining behavior, answers, comments, and exact versions', async () => {
  const f = await fixture();
  const runtime = ui();
  runtime.confirm.mockImplementationOnce(async () => {
    expect(runtime.logs.join('\n')).toContain('Before:');
    expect(runtime.logs.join('\n')).toContain('After:');
    expect(await readFile(f.file, 'utf8')).toBe(f.raw);
    return true;
  });
  await repairUrsReferences({ root: f.root, file: 'urs.yaml', context, observation }, runtime);
  const repaired = await loadUrs(f.file);
  expect(repaired.document).toEqual(f.urs.document);
  expect(repaired.open_questions).toEqual(f.urs.open_questions);
  expect(repaired.families[0].requirements[0]).toMatchObject({
    statement: f.urs.families[0].requirements[0].statement,
    details: f.urs.families[0].requirements[0].details,
    references: [],
    citations: [
      { source: 'design', location: 'DEFECTS.md' },
      { source: '@application', location: observation.url },
    ],
  });
  const output = await readFile(f.file, 'utf8');
  expect(output).toContain('# Human note at the top.');
  expect(output).toContain('# Keep the intended behavior note.');
  expect(output).toContain('# Keep the provenance note.');
  const history = path.join(f.root, '.provenarium/reference-repairs');
  const records = await readdir(history);
  expect(records).toHaveLength(2);
  expect(
    await readFile(
      path.join(
        history,
        records.find((name) => name.endsWith('.before.yaml'))!,
      ),
      'utf8',
    ),
  ).toBe(f.raw);
  expect(
    await readFile(
      path.join(
        history,
        records.find((name) => name.endsWith('.after.yaml'))!,
      ),
      'utf8',
    ),
  ).toBe(output);
});

it.each([false, Symbol('cancel')])(
  'does not modify YAML when review is declined or cancelled',
  async (answer) => {
    const f = await fixture();
    const runtime = ui();
    runtime.confirm.mockResolvedValue(answer);
    await repairUrsReferences({ root: f.root, file: 'urs.yaml', context, observation }, runtime);
    expect(await readFile(f.file, 'utf8')).toBe(f.raw);
    expect(await readdir(f.root)).toEqual(['urs.yaml']);
  },
);

it('requires explicit yes for unattended repair', async () => {
  const f = await fixture();
  const runtime = { ...ui(), isTTY: false };
  await repairUrsReferences({ root: f.root, file: 'urs.yaml', context, observation }, runtime);
  expect(await readFile(f.file, 'utf8')).toBe(f.raw);
  expect(runtime.confirm).not.toHaveBeenCalled();
  await repairUrsReferences(
    { root: f.root, file: 'urs.yaml', context, observation, yes: true },
    runtime,
  );
  expect((await loadUrs(f.file)).families[0].requirements[0].references).toEqual([]);
  expect(runtime.confirm).not.toHaveBeenCalled();
});

it('rejects a stale review without overwriting a concurrent edit', async () => {
  const f = await fixture();
  const runtime = ui();
  const edited = f.raw + '\n# Concurrent human edit.\n';
  runtime.confirm.mockImplementationOnce(async () => {
    await writeFile(f.file, edited);
    return true;
  });
  await expect(
    repairUrsReferences({ root: f.root, file: 'urs.yaml', context, observation }, runtime),
  ).rejects.toThrow('changed during reference repair');
  expect(await readFile(f.file, 'utf8')).toBe(edited);
  expect(await readdir(f.root)).toEqual(['urs.yaml']);
});

it('keeps genuinely missing references visible when applying supported provenance fixes', async () => {
  const f = await fixture();
  const document = structuredClone(f.urs);
  document.families[0].requirements[0].references.push('references/independent-calculations.csv');
  await writeFile(f.file, stringify(document));
  const runtime = ui();
  await repairUrsReferences({ root: f.root, file: 'urs.yaml', context, observation }, runtime);
  expect((await loadUrs(f.file)).families[0].requirements[0].references).toEqual([
    'references/independent-calculations.csv',
  ]);
  expect(runtime.logs.join('\n')).toContain(
    'missing reference references/independent-calculations.csv',
  );
});

it('does not guess unsupported repairs or create history when nothing is repairable', async () => {
  const f = await fixture();
  const runtime = ui();
  await repairUrsReferences(
    { root: f.root, file: 'urs.yaml', context: { passages: [], hashes: [], warnings: [] } },
    runtime,
  );
  expect(await readFile(f.file, 'utf8')).toBe(f.raw);
  expect(runtime.confirm).not.toHaveBeenCalled();
  expect(await readdir(f.root)).toEqual(['urs.yaml']);
});

it('refuses generated packages, history, escaped paths, and symlinked files', async () => {
  const f = await fixture();
  const runtime = ui();
  for (const relative of [
    'packages/pkg/urs.yaml',
    '.provenarium/resolutions/urs.yaml',
    'candidates/candidate/urs.yaml',
  ]) {
    await mkdir(path.dirname(path.join(f.root, relative)), { recursive: true });
    await writeFile(path.join(f.root, relative), f.raw);
    await expect(
      repairUrsReferences(
        { root: f.root, file: relative, context, observation, yes: true },
        runtime,
      ),
    ).rejects.toThrow('working URS');
  }
  await expect(
    repairUrsReferences(
      { root: f.root, file: '../outside.yaml', context, observation, yes: true },
      runtime,
    ),
  ).rejects.toThrow('Unsafe relative path');
  await symlink(f.file, path.join(f.root, 'linked.yaml'));
  await expect(
    repairUrsReferences(
      { root: f.root, file: 'linked.yaml', context, observation, yes: true },
      runtime,
    ),
  ).rejects.toThrow('Symlink');
  expect(await readFile(f.file, 'utf8')).toBe(f.raw);
});

it('refuses a project root nested within an approved package, including a symlink alias', async () => {
  const f = await fixture();
  const nested = path.join(f.root, 'nested');
  await mkdir(nested);
  await writeFile(path.join(f.root, 'approval.json'), '{}');
  await writeFile(path.join(nested, 'urs.yaml'), f.raw);
  const alias = path.join(f.root, 'alias');
  await symlink(nested, alias);
  for (const root of [nested, alias])
    await expect(
      repairUrsReferences({ root, file: 'urs.yaml', context, observation, yes: true }, ui()),
    ).rejects.toThrow('approved package');
});
