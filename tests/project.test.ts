import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planSchema, ursSchema } from '../src/schema.js';
import {
  approveCandidate,
  createCandidate,
  inspectCandidate,
  loadProject,
} from '../src/project.js';
import { checkUrs, templateText } from '../src/urs.js';
import { parseYaml, safePath, sha256, writeJson } from '../src/files.js';
import { compilePlan, validatePlan } from '../src/compiler.js';
import { protocolHtml, renderReport } from '../src/reports.js';

const roots: string[] = [];
async function directory() {
  const root = await mkdtemp(path.join(tmpdir(), 'provenarium project '));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const urs = ursSchema.parse({
  schema_version: 1,
  document: { id: 'URS-1', revision: '1', title: 'Receipt', intended_use: 'Record sample receipt' },
  families: [
    {
      id: 'receipt',
      title: 'Receipt',
      requirements: [
        { id: 'URS-001', title: 'Save', statement: 'The operator can save a sample.' },
      ],
    },
  ],
});
const plan = planSchema.parse({
  schema_version: 1,
  runtime_version: 1,
  id: 'PLAN-1',
  title: 'Receipt qualification',
  urs_revision: '1',
  target: { url: 'http://localhost:4173', allowed_origins: ['http://localhost:4173'] },
  environment: {},
  obligations: [
    {
      id: 'CLAUSE-1',
      requirement_id: 'URS-001',
      source: '/families/0/requirements/0/statement',
      statement: 'The operator can save a sample.',
      assertion_ids: ['A-1'],
    },
  ],
  cases: [
    {
      id: 'OQ-1',
      title: 'Save receipt',
      classification: 'OQ',
      requirements: ['URS-001'],
      steps: [
        {
          id: 'S-1',
          instruction: 'Inspect the form',
          actions: [{ op: 'navigate', url: '/' }],
          assertions: [
            {
              id: 'A-1',
              locator: { by: 'testId', value: 'receipt' },
              read: 'visible',
              comparison: 'equals',
              expected: true,
            },
          ],
          evidence: [{ id: 'E-1', kind: 'screenshot' }],
        },
      ],
    },
  ],
});

describe('requirements and approval contracts', () => {
  it('accepts an editable blank schema but does not treat it as ready for generation', async () => {
    const blank = ursSchema.parse(parseYaml(templateText));
    expect(await checkUrs(blank)).toEqual(
      expect.arrayContaining([expect.stringContaining('No requirements')]),
    );
  });
  it('rejects executable tags, aliases and unknown schema fields', () => {
    expect(() => parseYaml('value: !execute command')).toThrow();
    expect(() => parseYaml('value: &v [1]\ncopy: *v')).toThrow();
    expect(() => ursSchema.parse({ ...urs, shell: 'echo bad' })).toThrow();
  });
  it('maps every expected-result claim to assertions and explicit compiled case data', () => {
    expect(validatePlan(plan, urs)).toEqual([]);
    const html = protocolHtml(plan, urs, 'candidate');
    expect(html).toContain('visible of receipt equals true');
    expect(Object.values(compilePlan(plan))[0]).toContain('"expected": true');
    const missing = structuredClone(plan);
    missing.obligations[0].assertion_ids = [];
    expect(validatePlan(missing, urs)).toContain('CLAUSE-1: unmapped obligation.');
  });
  it('rejects unknown operations and unmet numeric expectations', () => {
    expect(() =>
      planSchema.parse({
        ...plan,
        cases: [
          {
            ...plan.cases[0],
            steps: [{ ...plan.cases[0].steps[0], actions: [{ op: 'evaluate', code: 'steal()' }] }],
          },
        ],
      }),
    ).toThrow();
    const numeric = structuredClone(plan);
    numeric.cases[0].steps[0].assertions[0].comparison = 'numeric';
    expect(validatePlan(numeric, urs)).toContain(
      'A-1: numeric comparison requires expected number and tolerance.',
    );
  });
  it('preserves candidates and approved inputs while revisions receive new identities', async () => {
    const root = await directory();
    const a = await createCandidate(root, urs, plan, { pdf: false });
    const approved = await approveCandidate(root, { pdf: false });
    const b = await createCandidate(root, urs, plan, { pdf: false });
    expect(a.id).not.toBe(b.id);
    expect((await loadProject(root)).current_package).toBe(approved.package_id);
    for (const [file, hash] of Object.entries(approved.files))
      expect(sha256(await readFile(path.join(root, 'packages', approved.package_id, file)))).toBe(
        hash,
      );
  });
  it('refuses hand-edited executable and readable candidate outputs', async () => {
    const root = await directory();
    const candidate = await createCandidate(root, urs, plan, { pdf: false });
    await writeFile(
      path.join(candidate.directory, 'tests/OQ-1.spec.cjs'),
      'throw new Error("changed")',
    );
    expect((await inspectCandidate(root)).errors).toContain(
      'Compiled test differs from plan: tests/OQ-1.spec.cjs',
    );
    await expect(approveCandidate(root, { pdf: false })).rejects.toThrow('Approval blocked');
  });
  it('blocks unresolved meaning and missing detailed requirement coverage', async () => {
    const root = await directory();
    const incomplete = structuredClone(plan);
    incomplete.questions = [{ id: 'Q-1', question: 'What is the expected limit?' }];
    await createCandidate(root, urs, incomplete, { pdf: false });
    await expect(approveCandidate(root, { pdf: false })).rejects.toThrow('expected limit');
  });
  it('rejects traversal and symlinks when assembling packages', async () => {
    const root = await directory();
    await expect(safePath(root, '../escape')).rejects.toThrow('Unsafe');
    await symlink(tmpdir(), path.join(root, 'escape'));
    await expect(safePath(root, 'escape/file')).rejects.toThrow('Symlink');
    const poisoned = structuredClone(plan);
    poisoned.fixtures = ['../file'];
    await expect(
      createCandidate(root, urs, poisoned, { files: { '../file': 'bad' }, pdf: false }),
    ).rejects.toThrow();
  });
  it('renders an unexecuted approved protocol and marks every case not_run', async () => {
    const root = await directory();
    await createCandidate(root, urs, plan, { pdf: false });
    await approveCandidate(root, { pdf: false });
    const report = await renderReport(root, { pdf: false });
    expect(await readFile(report.csv, 'utf8')).toContain('OQ-1: not_run');
    expect(await readFile(report.html, 'utf8')).toContain('IOQ protocol');
  });
  it('blocks undefined variables, unsupported role locators, and fabricated source anchors', () => {
    const invalid = structuredClone(plan);
    invalid.cases[0].steps[0].assertions[0] = {
      id: 'A-1',
      variable: 'missing.status',
      comparison: 'equals',
      expected: 200,
      read: 'text',
    };
    invalid.obligations[0].source = 'URS-001/not-a-field';
    expect(validatePlan(invalid, urs).join('\n')).toContain('undefined observation variable');
    expect(validatePlan(invalid, urs).join('\n')).toContain('source must point');
    expect(() =>
      planSchema.parse({
        ...plan,
        cases: [
          {
            ...plan.cases[0],
            steps: [
              {
                ...plan.cases[0].steps[0],
                actions: [{ op: 'click', locator: { by: 'role', value: 'Submit' } }],
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });
  it('rejects credentials embedded in the target URL before approval', () => {
    const invalid = structuredClone(plan);
    invalid.target.url += '/?token=do-not-retain';
    expect(validatePlan(invalid, urs)).toContain(
      'Target must be within allowed origins and contain no credentials.',
    );
  });
  it('rejects report directory and input-file symlinks', async () => {
    const root = await directory();
    await createCandidate(root, urs, plan, { pdf: false });
    const approved = await approveCandidate(root, { pdf: false });
    const pkg = path.join(root, 'packages', approved.package_id);
    await symlink(tmpdir(), path.join(pkg, 'reports'));
    await expect(renderReport(root, { pdf: false })).rejects.toThrow('Symlink');
    await rm(path.join(pkg, 'reports'));
    await rm(path.join(pkg, 'plan.json'));
    await symlink(path.join(root, 'external.json'), path.join(pkg, 'plan.json'));
    await expect(renderReport(root, { pdf: false })).rejects.toThrow('Symlink');
  });
  it('retains complete observations after a truncated final append and reconciles missing case results', async () => {
    const root = await directory();
    await createCandidate(root, urs, plan, { pdf: false });
    const approved = await approveCandidate(root, { pdf: false });
    const runId = 'run-interrupted',
      runDir = path.join(root, 'runs', runId);
    await writeJson(path.join(runDir, 'run.json'), {
      schema_version: 1,
      id: runId,
      package_id: approved.package_id,
      started_at: new Date().toISOString(),
      complete: true,
      target_url: plan.target.url,
      versions: { cli: '0.1.0' },
      accounts: {},
      cases: [],
      artifacts: [],
    });
    await writeFile(
      path.join(runDir, 'observations.jsonl'),
      JSON.stringify({
        run_id: runId,
        package_id: approved.package_id,
        case_id: 'OQ-1',
        step_id: 'S-1',
        assertion_id: 'A-1',
        timestamp: new Date().toISOString(),
        status: 'passed',
        actual: 'earlier-observation',
        expected: true,
        artifacts: [],
      }) + '\n{"partial":',
    );
    const report = await renderReport(root, { runId, pdf: false });
    const html = await readFile(report.html, 'utf8');
    expect(html).toContain('earlier-observation');
    expect(html).toContain('Unreadable or inconsistent observation at line 2');
    expect(html).toContain('Missing or ambiguous case result: OQ-1');
    expect(html).toContain('INCOMPLETE RUN');
  });
});
