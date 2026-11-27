import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planSchema, ursSchema } from '../src/schema.js';
import { applyPlanEdits, type PlanEdits } from '../src/authoring/plan-edits.js';
import { automationCheckpoint, findAutomationResume } from '../src/authoring/automation-resume.js';
import type { ProviderOutputDiagnostic } from '../src/authoring/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const urs = ursSchema.parse({
  schema_version: 1,
  document: { id: 'URS', revision: '1', title: 'Register', intended_use: 'Review records.' },
  families: [
    {
      id: 'F',
      title: 'Records',
      requirements: [
        { id: 'R1', title: 'Ready', statement: 'Display Ready in each independent browser.' },
      ],
    },
  ],
});
function base() {
  return {
    plan: planSchema.parse({
      schema_version: 1,
      runtime_version: 1,
      id: 'PLAN',
      title: 'Register',
      urs_revision: '1',
      target: { url: 'https://example.test/', allowed_origins: ['https://example.test'] },
      environment: {},
      obligations: ['A', 'B'].map((id) => ({
        id: 'OB-' + id,
        requirement_id: 'R1',
        source: 'R1/statement',
        statement: 'Ready is displayed.',
        manual_case_ids: [id],
      })),
      cases: ['A', 'B'].map((id) => ({
        id,
        title: 'Ready ' + id,
        classification: 'OQ',
        requirements: ['R1'],
        manual: true,
        manual_procedure: 'Open the page and inspect its status.',
        manual_expected: 'Ready',
        steps: [],
      })),
    }),
    fixtures: [],
  };
}
function proposal(id: string): PlanEdits {
  return {
    edits: [
      {
        op: 'automate_case',
        case_id: id,
        preserved_manual_expected: 'Ready',
        coverage: [{ obligation_id: 'OB-' + id, assertion_ids: ['ASSERT-' + id] }],
        steps: [
          {
            id: '01',
            instruction: 'Open the page and read its status.',
            actions: [{ op: 'navigate', url: '/' }],
            assertions: [
              {
                id: 'ASSERT-' + id,
                locator: { by: 'css', value: '#status' },
                read: 'text',
                comparison: 'equals',
                expected: 'Ready',
              },
            ],
            evidence: [],
          },
        ],
      },
    ],
  };
}
function diagnostic(p: PlanEdits): ProviderOutputDiagnostic {
  return {
    request: 1,
    kind: 'protocol_edits',
    operation: 'case automation',
    issues: [],
    truncated: false,
    candidate: { proposal: p },
  };
}
async function project(record: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'provenarium-resume-'));
  roots.push(root);
  await mkdir(join(root, 'drafts'));
  await writeFile(join(root, 'drafts', 'retained.json'), JSON.stringify(record));
  return root;
}
const options = {
  base: base(),
  urs,
  previousUrs: urs,
  target: 'https://example.test/',
  contextHashes: [],
  inputsModifiedAt: 0,
};

it('replays the exact completed conversions from a legacy failure without adopting unverified edits', async () => {
  const p = proposal('A');
  const value = applyPlanEdits(options.base, p, {
    urs,
    mode: 'review',
    allowManualConversion: true,
  }).value;
  const root = await project({ incomplete: true, value, diagnostics: [diagnostic(p)] });
  const resumed = await findAutomationResume({ ...options, root });
  expect(resumed?.converted).toBe(1);
  expect(resumed?.value).toEqual(value);
  expect(resumed?.file).toBe('drafts/retained.json');
  expect(options.base.plan.cases.every((c) => c.manual)).toBe(true);
});

it('chains fingerprinted conversions and retains the automation checkpoint before later review edits', async () => {
  const first = automationCheckpoint({ ...options, diagnostics: [diagnostic(proposal('A'))] })!;
  const next = automationCheckpoint({
    ...options,
    prior: first,
    diagnostics: [
      diagnostic(proposal('B')),
      {
        ...diagnostic({ edits: [] }),
        candidate: {
          proposal: {
            edits: [
              {
                op: 'update_instruction',
                case_id: 'A',
                step_id: '01',
                instruction: 'Later change',
              },
            ],
          },
        },
      },
    ],
  })!;
  expect(next.proposals).toHaveLength(2);
  const root = await project({ incomplete: true, generation_resume: next });
  const resumed = await findAutomationResume({ ...options, root });
  expect(resumed?.converted).toBe(2);
  expect(resumed?.value.plan.cases.every((c) => !c.manual)).toBe(true);
});

it.each(['requirements', 'candidate', 'context', 'target', 'checkpoint'] as const)(
  'rejects stale or tampered %s in fingerprinted work',
  async (kind) => {
    const checkpoint = automationCheckpoint({
      ...options,
      diagnostics: [diagnostic(proposal('A'))],
    })!;
    const changed = structuredClone(options);
    if (kind === 'requirements')
      changed.urs.families[0].requirements[0].statement = 'Different approved behavior.';
    if (kind === 'candidate') changed.base.plan.title = 'Different candidate';
    if (kind === 'context')
      checkpoint.context_hashes = [
        { source: 'source-1', location: 'app.js', sha256: 'a'.repeat(64) },
      ];
    if (kind === 'target') changed.target = 'https://other.test/';
    if (kind === 'checkpoint')
      checkpoint.checkpoint.plan.cases[0].steps[0].assertions[0].expected = 'Wrong';
    const root = await project({ incomplete: true, generation_resume: checkpoint });
    expect(await findAutomationResume({ ...changed, root })).toBeUndefined();
  },
);

it('rejects legacy records whose inputs changed, whose replay is incomplete, or whose value differs', async () => {
  const p = proposal('A');
  const value = applyPlanEdits(options.base, p, {
    urs,
    mode: 'review',
    allowManualConversion: true,
  }).value;
  const root = await project({ incomplete: true, value, diagnostics: [diagnostic(p)] });
  expect(
    await findAutomationResume({ ...options, root, inputsModifiedAt: Date.now() + 10000 }),
  ).toBeUndefined();
  await writeFile(
    join(root, 'drafts', 'retained.json'),
    JSON.stringify({ incomplete: true, value, diagnostics: [] }),
  );
  expect(await findAutomationResume({ ...options, root })).toBeUndefined();
  value.plan.cases[0].steps[0].assertions[0].expected = 'Wrong';
  await writeFile(
    join(root, 'drafts', 'retained.json'),
    JSON.stringify({ incomplete: true, value, diagnostics: [diagnostic(p)] }),
  );
  expect(await findAutomationResume({ ...options, root })).toBeUndefined();
});

it('does not treat unrelated or successful authoring records as automation checkpoints', async () => {
  const root = await project({ incomplete: false, value: options.base, diagnostics: [] });
  expect(await findAutomationResume({ ...options, root })).toBeUndefined();
  expect(automationCheckpoint({ ...options, diagnostics: [] })).toBeUndefined();
});

it('checkpoints validated conversion proposals even when diagnostic snapshots were truncated', async () => {
  const p = proposal('A');
  p.edits[0].op === 'automate_case' &&
    (p.edits[0].steps[0].instruction = 'Detailed retained procedure. '.repeat(2500));
  const checkpoint = automationCheckpoint({
    ...options,
    proposals: [p],
    diagnostics: [
      {
        kind: 'protocol_edits',
        operation: 'case automation',
        request: 2,
        issues: [],
        truncated: true,
      },
    ],
  })!;
  expect(checkpoint.proposals).toHaveLength(1);
  const root = await project({ incomplete: true, generation_resume: checkpoint });
  const resumed = await findAutomationResume({ ...options, root });
  expect(resumed?.converted).toBe(1);
  expect(resumed?.value.plan.cases[0].steps[0].instruction.length).toBeGreaterThan(64000);
});

it('retains a fixture-only progress step followed by its case conversion', async () => {
  const addFixture: PlanEdits = {
    edits: [
      {
        op: 'add_fixture',
        value: {
          path: 'fixtures/derivation.txt',
          content: 'Independent derivation retained for review.',
        },
      },
    ],
  };
  const checkpoint = automationCheckpoint({ ...options, proposals: [addFixture, proposal('A')] })!;
  expect(checkpoint.proposals).toHaveLength(2);
  const root = await project({ incomplete: true, generation_resume: checkpoint });
  expect((await findAutomationResume({ ...options, root }))?.value.fixtures).toEqual([
    { path: 'fixtures/derivation.txt', content: 'Independent derivation retained for review.' },
  ]);
});
