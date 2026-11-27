import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planSchema, ursSchema, type RequirementsApproval } from '../src/schema.js';
import {
  approveCandidate,
  createCandidate,
  inspectCandidate,
  loadProject,
} from '../src/project.js';
import { checkUrs, templateText } from '../src/urs.js';
import { applyResolutionProposal } from '../src/urs-resolution.js';
import { parseYaml, safePath, sha256, writeJson } from '../src/files.js';
import { compilePlan, validatePlan } from '../src/compiler.js';
import { protocolHtml, renderReport, ursHtml } from '../src/reports.js';
import { verifyApprovedPackage } from '../src/runtime/index.js';

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

function rehearsalAuthorization(fixturePlan = plan, inputHashes = {}): RequirementsApproval {
  return {
    approved_at: '2026-11-27T14:00:00.000Z',
    urs_sha256: sha256(JSON.stringify(urs)),
    target_url: new URL(fixturePlan.target.url).href,
    rehearsal_plan_sha256: sha256(JSON.stringify(fixturePlan)),
    rehearsal_input_hashes: inputHashes,
  };
}

describe('execution authorized by a reviewed URS', () => {
  it('freezes the rehearsed candidate and documents what the human approved', async () => {
    const root = await directory();
    const fixturePlan = { ...plan, fixtures: ['fixtures/sample.txt'] };
    const content = 'rehearsed fixture';
    const authorization = rehearsalAuthorization(fixturePlan, {
      'fixtures/sample.txt': sha256(content),
    });
    await createCandidate(root, urs, fixturePlan, {
      pdf: false,
      files: { 'fixtures/sample.txt': content },
    });
    const approval = await approveCandidate(root, {
      pdf: false,
      requirementsApproval: authorization,
    });
    expect(approval.requirements_approval).toEqual(authorization);
    const selected = await verifyApprovedPackage(root, approval.package_id);
    expect(selected.plan).toEqual(fixturePlan);
    expect(approval.files['fixtures/sample.txt']).toBe(sha256(content));
    const report = await renderReport(root, { packageId: approval.package_id, pdf: false });
    const detail = 'The generated IOQ and tests were frozen after the browser dry run.';
    expect(await readFile(report.html, 'utf8')).toContain(detail);
    expect(await readFile(path.join(selected.packageDirectory, 'ioq.html'), 'utf8')).toContain(
      detail,
    );

    const approvalFile = path.join(selected.packageDirectory, 'approval.json');
    await writeJson(approvalFile, {
      ...approval,
      requirements_approval: { ...authorization, rehearsal_plan_sha256: '0'.repeat(64) },
    });
    await expect(verifyApprovedPackage(root, approval.package_id)).rejects.toThrow(
      'differs from the rehearsed plan',
    );
  });

  it.each([
    [{ urs_sha256: '0'.repeat(64) }, 'differ from the reviewed URS'],
    [{ target_url: 'https://example.test/' }, 'differs from the authorized deployment'],
    [{ rehearsal_plan_sha256: '0'.repeat(64) }, 'differs from the rehearsed plan'],
  ])('rejects mismatched requirements, target, and plan identity', async (change, message) => {
    const root = await directory();
    await createCandidate(root, urs, plan, { pdf: false });
    await expect(
      approveCandidate(root, {
        pdf: false,
        requirementsApproval: { ...rehearsalAuthorization(), ...change },
      }),
    ).rejects.toThrow(message);
    expect((await loadProject(root)).current_package).toBeUndefined();
  });

  it('requires the exact files used by the dry run before freezing', async () => {
    const root = await directory();
    const fixturePlan = { ...plan, fixtures: ['fixtures/sample.txt'] };
    const candidate = await createCandidate(root, urs, fixturePlan, {
      pdf: false,
      files: { 'fixtures/sample.txt': 'before' },
    });
    await expect(
      approveCandidate(root, {
        pdf: false,
        requirementsApproval: rehearsalAuthorization(fixturePlan),
      }),
    ).rejects.toThrow('rehearsal did not record candidate input fixtures/sample.txt');
    await writeFile(path.join(candidate.directory, 'fixtures/sample.txt'), 'after');
    await expect(
      approveCandidate(root, {
        pdf: false,
        requirementsApproval: rehearsalAuthorization(fixturePlan, {
          'fixtures/sample.txt': sha256('before'),
        }),
      }),
    ).rejects.toThrow('Candidate input changed after rehearsal: fixtures/sample.txt');
    expect((await loadProject(root)).current_package).toBeUndefined();
  });
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
  it('retains an auditable preparation reclassification while preserving all expected results', async () => {
    const root = await directory();
    const before = structuredClone(plan);
    before.cases.push({
      id: 'OQ-MANUAL',
      title: 'Persistent browser check',
      classification: 'OQ',
      requirements: ['URS-001'],
      prerequisites: ['Prepare a persistent browser profile.'],
      manual: true,
      manual_procedure: 'Save a record and restart the browser.',
      manual_expected: 'The record remains saved.',
      steps: [],
      citations: [],
    });
    before.questions = [
      { id: 'Q-PROFILE', question: 'Which profile will be used?', requirement: 'URS-001' },
    ];
    const original = await createCandidate(root, urs, before, { pdf: false });
    expect((await inspectCandidate(root)).errors.join('\n')).toContain('Q-PROFILE');
    const after = structuredClone(before);
    after.questions[0].kind = 'execution_preparation';
    after.questions[0].case_ids = ['OQ-MANUAL'];
    const next = await createCandidate(root, urs, after, { pdf: false });
    expect((await inspectCandidate(root)).errors).toEqual([]);
    const diff = JSON.parse(await readFile(path.join(next.directory, 'changes.json'), 'utf8'));
    expect(diff.previous_candidate).toContain(original.id);
    expect(diff.expectations).toEqual([]);
    expect(diff.question_changes).toEqual([
      { id: 'Q-PROFILE', previous: before.questions[0], next: after.questions[0] },
    ]);
    expect(
      JSON.parse(await readFile(path.join(original.directory, 'plan.json'), 'utf8')).questions,
    ).toEqual(before.questions);
    const approval = await approveCandidate(root, { pdf: false });
    const retained = JSON.parse(
      await readFile(path.join(root, 'packages', approval.package_id, 'plan.json'), 'utf8'),
    );
    expect(retained.questions).toEqual(after.questions);
    expect(retained.cases).toEqual(before.cases);
  });

  it('retains reviewed questions and answers in approved packages without blocking approval', async () => {
    const root = await directory();
    const answered = structuredClone(urs);
    answered.open_questions = [
      {
        id: 'Q-SAVE',
        requirement: 'URS-001',
        question: 'May the operator save a sample?',
        answer: 'Yes, the operator can save a sample.',
      },
    ];
    expect(validatePlan(plan, answered)).toContain('Resolve URS questions before approval.');
    expect((await checkUrs(answered)).join('\n')).toContain('urs resolve');
    const resolved = applyResolutionProposal(answered, {
      requirements: [
        {
          question_ids: ['Q-SAVE'],
          value: answered.families[0].requirements[0],
          reason: 'The existing statement already specifies the accepted save behavior.',
        },
      ],
      unresolved: [],
    });
    const updatedPlan = structuredClone(plan);
    updatedPlan.urs_revision = resolved.document.revision;
    expect(await checkUrs(resolved)).toEqual([]);
    expect(validatePlan(updatedPlan, resolved)).toEqual([]);
    await createCandidate(root, resolved, updatedPlan, { pdf: false });
    const approval = await approveCandidate(root, { pdf: false });
    const retained = ursSchema.parse(
      parseYaml(
        await readFile(path.join(root, 'packages', approval.package_id, 'urs.yaml'), 'utf8'),
      ),
    );
    expect(retained.open_questions).toEqual(resolved.open_questions);
  });
  it('renders retained answers and question statuses while escaping their content', () => {
    const answered = structuredClone(urs);
    answered.open_questions = [
      {
        id: 'Q-SAVE',
        requirement: 'URS-001',
        question: 'May the operator save <script>alert(1)</script>?',
        answer: 'Show <strong>Save</strong> to the operator.',
      },
    ];
    const pendingHtml = ursHtml(answered);
    expect(pendingHtml).toContain('Answer recorded; changes pending review');
    expect(pendingHtml).toContain('Show &lt;strong&gt;Save&lt;/strong&gt;');
    expect(pendingHtml).not.toContain('<script>');
    const resolved = applyResolutionProposal(answered, {
      requirements: [
        {
          question_ids: ['Q-SAVE'],
          value: answered.families[0].requirements[0],
          reason: 'Synthetic rendering fixture.',
        },
      ],
      unresolved: [],
    });
    const resolvedHtml = ursHtml(resolved);
    expect(resolvedHtml).toContain('Resolved; requirement changes reviewed');
    expect(resolvedHtml).toContain('Q-SAVE');
    expect(resolvedHtml).toContain('Show &lt;strong&gt;Save&lt;/strong&gt;');
    expect(resolvedHtml).not.toContain('<script>');
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
