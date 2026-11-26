import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ursSchema } from '../src/schema.js';
import { sha256 } from '../src/files.js';
import {
  collectPlanInputCatalog,
  validateGeneratedPlanInputs,
  type GeneratedPlanInputs,
} from '../src/plan-inputs.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, readFile: vi.fn(original.readFile) };
});

const roots: string[] = [];
beforeEach(() => {
  vi.mocked(readFile).mockClear();
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'provenarium plan inputs '));
  roots.push(root);
  await mkdir(join(root, 'references'));
  return root;
}
function urs(references: string[]) {
  return ursSchema.parse({
    schema_version: 1,
    document: {
      id: 'URS',
      revision: '1',
      title: 'Dilution',
      intended_use: 'Synthetic dilution validation',
    },
    families: [
      {
        id: 'calc',
        title: 'Calculation',
        requirements: [
          {
            id: 'URS-CALC',
            title: 'Calculation',
            statement: 'Calculate independent example values.',
            references,
          },
        ],
      },
    ],
  });
}
function generated(references: string[] = []): GeneratedPlanInputs {
  return {
    plan: { references, fixtures: ['fixtures/inputs.csv'] },
    fixtures: [{ path: 'fixtures/inputs.csv', content: 'sample,stock,target,volume\nA,10,2,10\n' }],
  };
}

it('catalogs only explicit normative files, preserving paths with spaces and requirement links', async () => {
  const root = await project();
  const reference = 'references/independent examples.csv';
  const content = 'stock,target,volume,expected_stock\n10,2,10,2\n';
  await writeFile(join(root, reference), content);
  await writeFile(join(root, 'unrelated-private-data.csv'), 'not selected');
  const document = urs([reference]);
  document.families[0].requirements.push({
    ...document.families[0].requirements[0],
    id: 'URS-EXPORT',
  });

  const catalog = await collectPlanInputCatalog(root, document);

  expect(catalog).toEqual({
    references: [
      { path: reference, requirements: ['URS-CALC', 'URS-EXPORT'], sha256: sha256(content) },
    ],
    errors: [],
  });
  expect(vi.mocked(readFile).mock.calls.map(([file]) => file)).toEqual([join(root, reference)]);
});

it('rejects missing, directory, symlink, remote, and unsafe normative files instead of inventing inputs', async () => {
  const root = await project();
  await mkdir(join(root, 'references/directory'));
  await writeFile(join(root, 'references/actual.csv'), 'known');
  await symlink(join(root, 'references/actual.csv'), join(root, 'references/link.csv'));
  const references = [
    'references/missing-scientific-values.csv',
    'references/directory',
    'references/link.csv',
    '../outside.csv',
    '/tmp/outside.csv',
    'https://example.test/calculations.csv',
    'context:design',
    'urs.yaml',
  ];

  const catalog = await collectPlanInputCatalog(root, urs(references));

  expect(catalog.references).toEqual([]);
  expect(catalog.errors).toHaveLength(references.length);
  expect(catalog.errors.join('\n')).toContain('missing-scientific-values.csv');
  expect(vi.mocked(readFile)).not.toHaveBeenCalled();
});

it('accepts generated fixtures alongside the exact retained normative inputs', async () => {
  const root = await project();
  const reference = 'references/calculation-examples.csv';
  await writeFile(join(root, reference), 'independent expected values');
  const catalog = await collectPlanInputCatalog(root, urs([reference]));

  expect(await validateGeneratedPlanInputs(root, generated([reference]), catalog)).toEqual([]);
});

it('rejects the reported prose references and unapproved existing files before reading model paths', async () => {
  const root = await project();
  await writeFile(join(root, 'private-not-referenced.csv'), 'must not be read');
  const catalog = await collectPlanInputCatalog(root, urs([]));
  vi.mocked(readFile).mockClear();
  const references = [
    'URS-DILUTION-BENCH, Draft 0.2, including its accepted human resolutions.',
    'Execution gate: The local schema permits nonempty source strings but does not supply the runtime binding grammar.',
    'Independent calculation reference pending controlled attachment.',
    'private-not-referenced.csv',
  ];

  const errors = await validateGeneratedPlanInputs(root, generated(references), catalog);

  expect(errors).toHaveLength(references.length);
  expect(errors.join('\n')).toContain('available_reference_files');
  expect(vi.mocked(readFile)).not.toHaveBeenCalled();
});

it('keeps missing scientific input errors even when the model omits the reference', async () => {
  const root = await project();
  const catalog = await collectPlanInputCatalog(root, urs(['references/independent-values.csv']));
  const errors = await validateGeneratedPlanInputs(root, generated(), catalog);
  expect(errors).toEqual(catalog.errors);
  expect(errors[0]).toContain('cannot substitute invented evidence');
});

it('requires every supplied normative input to remain declared', async () => {
  const root = await project();
  const reference = 'references/expected.csv';
  await writeFile(join(root, reference), 'expected');
  const catalog = await collectPlanInputCatalog(root, urs([reference]));
  expect((await validateGeneratedPlanInputs(root, generated(), catalog)).join('\n')).toContain(
    'required by URS-CALC is missing from plan.references',
  );
});

it('detects an authorized input changed during authoring', async () => {
  const root = await project();
  const reference = 'references/expected.csv';
  await writeFile(join(root, reference), 'reviewed values');
  const catalog = await collectPlanInputCatalog(root, urs([reference]));
  await writeFile(join(root, reference), 'different values');

  expect(
    (await validateGeneratedPlanInputs(root, generated([reference]), catalog)).join('\n'),
  ).toContain('changed during authoring');
});

it.each(['removed', 'symlink'] as const)(
  'rejects a normative input that becomes %s after cataloging',
  async (change) => {
    const root = await project();
    const reference = 'references/expected.csv';
    await writeFile(join(root, reference), 'reviewed values');
    const catalog = await collectPlanInputCatalog(root, urs([reference]));
    await rm(join(root, reference));
    if (change === 'symlink') {
      await writeFile(join(root, 'outside.csv'), 'different values');
      await symlink(join(root, 'outside.csv'), join(root, reference));
    }
    vi.mocked(readFile).mockClear();

    expect(
      (await validateGeneratedPlanInputs(root, generated([reference]), catalog)).join('\n'),
    ).toContain('no longer a readable regular file');
    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
  },
);

it('prevents generated fixture content from replacing a supplied normative reference', async () => {
  const root = await project();
  await mkdir(join(root, 'fixtures'));
  const reference = 'fixtures/reviewed-values.csv';
  await writeFile(join(root, reference), 'independently reviewed');
  const catalog = await collectPlanInputCatalog(root, urs([reference]));
  const candidate = generated([reference]);
  candidate.fixtures.push({ path: reference, content: 'invented replacement' });

  expect((await validateGeneratedPlanInputs(root, candidate, catalog)).join('\n')).toContain(
    'would replace a supplied normative reference',
  );
});

it('reports repeated, orphaned, and undeclared fixture content before package writes', async () => {
  const root = await project();
  const candidate = generated();
  candidate.fixtures.push(
    { ...candidate.fixtures[0] },
    { path: 'fixtures/orphan.csv', content: 'orphan' },
  );
  candidate.plan.fixtures.push('fixtures/missing.csv');
  candidate.plan.references.push('fixtures/inputs.csv');

  const errors = await validateGeneratedPlanInputs(
    root,
    candidate,
    await collectPlanInputCatalog(root, urs([])),
  );
  expect(errors.join('\n')).toContain('is repeated');
  expect(errors.join('\n')).toContain('is declared more than once');
  expect(errors.join('\n')).toContain('has no generated fixture content');
  expect(errors.join('\n')).toContain('is not declared in plan.fixtures or plan.references');
});

it('permits a newly generated text input declared only as a plan reference', async () => {
  const root = await project();
  const candidate = generated();
  candidate.fixtures.push({
    path: 'fixtures/derived-examples.csv',
    content: 'transparent derived example data',
  });
  candidate.plan.references.push('fixtures/derived-examples.csv');
  expect(
    await validateGeneratedPlanInputs(
      root,
      candidate,
      await collectPlanInputCatalog(root, urs([])),
    ),
  ).toEqual([]);
});

it('rejects unsafe and reserved generated names without opening model-selected files', async () => {
  const root = await project();
  const names = [
    'fixtures/../escape.csv',
    '/tmp/escape.csv',
    'fixtures\\escape.csv',
    'fixtures/.hidden.csv',
    'plan.json',
    'tests/injected.spec.cjs',
    'https://example.test/input.csv',
  ];
  const candidate = {
    plan: { fixtures: names, references: [] },
    fixtures: names.map((path) => ({ path, content: 'untrusted' })),
  };
  const errors = await validateGeneratedPlanInputs(
    root,
    candidate,
    await collectPlanInputCatalog(root, urs([])),
  );
  expect(errors.length).toBeGreaterThanOrEqual(names.length);
  expect(vi.mocked(readFile)).not.toHaveBeenCalled();
});
