import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ContextBundle } from '../src/context.js';
import { ursSchema } from '../src/schema.js';
import { checkUrs, checkUrsStructure } from '../src/urs.js';
import { checkUrsReference, normalizeGeneratedUrsReferences } from '../src/urs-references.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function directory() {
  const root = await mkdtemp(path.join(tmpdir(), 'provenarium references '));
  roots.push(root);
  return root;
}
function document(references: string[] = []) {
  return ursSchema.parse({
    schema_version: 1,
    document: {
      id: 'URS-DEMO',
      revision: '1',
      title: 'Synthetic app',
      intended_use: 'Exercise validation.',
    },
    families: [
      {
        id: 'inputs',
        title: 'Inputs',
        requirements: [
          {
            id: 'URS-INPUT',
            title: 'Positive volume',
            statement: 'Reject zero final volume without changing saved records.',
            references,
          },
        ],
      },
    ],
    open_questions: [
      {
        id: 'Q-EMPTY',
        question: 'Should an empty export include column headings?',
        requirement: 'URS-INPUT',
        answer: null,
      },
    ],
  });
}
const emptyContext: ContextBundle = { passages: [], hashes: [], warnings: [] };
const appUrl = 'https://example.test/correct/';
const observation = {
  url: appUrl,
  title: 'Dilution Bench',
  text: 'Before you calculate',
  controls: [],
  links: [],
};

it('converts the actual malformed observation labels and case IDs to supplied provenance', async () => {
  const root = await directory();
  const original = document([
    'OQ-ZERO-VOLUME',
    `Hosted observation: ${appUrl} — Before you calculate`,
  ]);
  const context: ContextBundle = {
    ...emptyContext,
    passages: [
      {
        source: 'source-1',
        location: 'examples/dilution-app/DEFECTS.md',
        text: '| zero-volume | Reject with a field-specific error and leave records unchanged. | `OQ-ZERO-VOLUME` |',
      },
    ],
  };
  const normalized = await normalizeGeneratedUrsReferences(original, {
    root,
    context,
    observation,
  });
  expect(normalized.errors).toEqual([]);
  expect(normalized.changes.map((change) => change.reference)).toEqual(
    original.families[0].requirements[0].references,
  );
  expect(normalized.urs.families[0].requirements[0]).toMatchObject({
    references: [],
    citations: [
      { source: 'source-1', location: 'examples/dilution-app/DEFECTS.md' },
      { source: '@application', location: appUrl },
    ],
  });
  expect(original.families[0].requirements[0].references).toHaveLength(2);
  expect(await checkUrsStructure(normalized.urs, root)).toEqual([]);
  expect(await checkUrs(normalized.urs, root)).toEqual([expect.stringContaining('Q-EMPTY:')]);
});

it('uses the supplied web source citation and avoids duplicating existing citations', async () => {
  const root = await directory();
  const urs = document([`Hosted observation: ${appUrl}#inputs — Input controls`]);
  urs.families[0].requirements[0].citations = [{ source: 'web', location: appUrl }];
  const context = {
    ...emptyContext,
    passages: [{ source: 'web', location: appUrl, text: 'Input controls' }],
  };
  const result = await normalizeGeneratedUrsReferences(urs, { root, context, observation });
  expect(result.errors).toEqual([]);
  expect(result.urs.families[0].requirements[0].citations).toEqual([
    { source: 'web', location: appUrl },
  ]);
});

it('does not manufacture provenance for unseen pages or unmatched case identifiers', async () => {
  const root = await directory();
  const urs = document(['OQ-ZERO-VOLUME', 'Hosted observation: https://unseen.test/ — Results']);
  const context = {
    ...emptyContext,
    passages: [
      {
        source: 'source-1',
        location: 'defects.md',
        text: 'OQ-ZERO-VOLUME-OTHER has a different expected result.',
      },
    ],
  };
  const result = await normalizeGeneratedUrsReferences(urs, { root, context, observation });
  expect(result.changes).toEqual([]);
  expect(result.urs).toEqual(urs);
  expect(result.errors).toHaveLength(2);
});

it('preserves readable normative files even when their names look like case IDs', async () => {
  const root = await directory();
  await mkdir(path.join(root, 'references'));
  await writeFile(path.join(root, 'OQ-ZERO-VOLUME'), 'Reviewed expected results.');
  await writeFile(
    path.join(root, 'references/calculation-examples.csv'),
    'stock,target,final,expected\n10,2,10,2\n',
  );
  const urs = document(['OQ-ZERO-VOLUME', 'references/calculation-examples.csv']);
  const context = {
    ...emptyContext,
    passages: [
      { source: 'source-1', location: 'defects.md', text: 'OQ-ZERO-VOLUME checks invalid volume.' },
    ],
  };
  const result = await normalizeGeneratedUrsReferences(urs, { root, context });
  expect(result.changes).toEqual([]);
  expect(result.errors).toEqual([]);
  expect(result.urs).toEqual(urs);
});

it('retains genuinely missing scientific reference files as blocking errors', async () => {
  const root = await directory();
  const urs = document(['references/calculation-examples.csv']);
  const result = await normalizeGeneratedUrsReferences(urs, { root, context: emptyContext });
  expect(result.urs).toEqual(urs);
  expect(result.changes).toEqual([]);
  expect(result.errors).toEqual([
    'URS-INPUT: missing reference references/calculation-examples.csv',
  ]);
  expect(await checkUrsStructure(result.urs, root)).toEqual(result.errors);
});

it('preserves explicit external normative references for the existing package-retention gate', async () => {
  const root = await directory();
  const urs = document(['https://example.test/design.pdf', 'context:design']);
  const result = await normalizeGeneratedUrsReferences(urs, { root, context: emptyContext });
  expect(result.urs).toEqual(urs);
  expect(result.changes).toEqual([]);
  expect(result.errors).toEqual([]);
});

it.each([
  'https://example.test/design.pdf — Required limits',
  'https://name:password@example.test/design.pdf',
  'https://',
  'context:',
  'context:design notes',
  '../secret.csv',
  '/tmp/secret.csv',
  'references/../secret.csv',
  'references\\secret.csv',
])(
  'rejects malformed or escaping references even without a filesystem root: %s',
  async (reference) => {
    expect(await checkUrsReference('URS-INPUT', reference)).toBeTypeOf('string');
  },
);

it('rejects symlinked references and directories without weakening local-file checks', async () => {
  const root = await directory();
  await mkdir(path.join(root, 'references'));
  await writeFile(path.join(root, 'actual.csv'), 'expected\n2\n');
  await symlink(path.join(root, 'actual.csv'), path.join(root, 'references/alias.csv'));
  for (const reference of ['references', 'references/alias.csv'])
    expect(await checkUrsReference('URS-INPUT', reference, root)).toContain('unsafe or unreadable');
});

it('separates pending decisions from duplicate IDs, broken links, and invalid table structure', async () => {
  const root = await directory();
  const urs = document();
  urs.families[0].requirements[0].table = { columns: ['Unit', 'Value'], rows: [['mL']] };
  urs.families[0].requirements.push(structuredClone(urs.families[0].requirements[0]));
  urs.open_questions[0].requirement = 'URS-MISSING';
  const errors = await checkUrsStructure(urs, root);
  expect(errors).toEqual(
    expect.arrayContaining([
      'Duplicate ID: URS-INPUT',
      'URS-INPUT: table row width differs from headers.',
      'Q-EMPTY: unknown requirement URS-MISSING',
    ]),
  );
  expect(errors.join('\n')).not.toContain('Answer beside');
});
