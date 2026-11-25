#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  loadUrs,
  planSchema,
  createCandidate,
  approveCandidate,
  renderReport,
} from '../dist/index.js';
import { executePackage } from '../dist/runtime/index.js';
import { startDilutionApp } from '../dist/examples/dilution-app/server.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: { output: { type: 'string' }, pdf: { type: 'boolean', default: false } },
});
const base = resolve(values.output ?? join(repository, '.demo-results', 'dilution'));
await mkdir(base, { recursive: true });
const project = await mkdtemp(join(base, 'comparison-'));
const example = join(repository, 'examples', 'dilution-validation');
const expectedFailures = [
  'OQ-UNIT-CONVERSION',
  'OQ-ZERO-VOLUME',
  'OQ-DUPLICATE-ID',
  'OQ-CSV-EXPORT',
].sort();
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
let app;
try {
  app = await startDilutionApp({ port: 0 });
  const urs = await loadUrs(join(example, 'urs.yaml'));
  const plan = planSchema.parse(JSON.parse(await readFile(join(example, 'plan.json'), 'utf8')));
  plan.target = { url: app.url, allowed_origins: [app.url] };
  const files = {};
  for (const relative of [...plan.fixtures, ...plan.references])
    files[relative] = await readFile(join(example, relative));
  console.log(`Validation project: ${project}`);
  console.log('Compiling the reviewed demonstration protocol; no provider calls.');
  await createCandidate(project, urs, plan, { files, pdf: values.pdf });
  const approval = await approveCandidate(project, { pdf: values.pdf });
  const approvalPath = join(project, 'packages', approval.package_id, 'approval.json');
  const approvalHash = hash(await readFile(approvalPath));
  const results = {};
  for (const mode of ['faulty', 'correct']) {
    if (mode === 'correct') {
      await app.resetRecords();
      app.setDefects([]);
    }
    console.log(`Running ${mode} application against ${approval.package_id} ...`);
    const run = await executePackage(project, approval.package_id, {
      bindings: {},
      releaseLabel: `dilution-${mode}`,
    });
    const report = await renderReport(project, { runId: run.id, pdf: values.pdf });
    // Keep reports before checking expectations so unexpected outcomes remain inspectable.
    assert.equal(run.complete, true, `${mode}: execution was interrupted`);
    assert.equal(run.cases.length, plan.cases.length, `${mode}: case inventory changed`);
    assert.deepEqual(
      run.cases
        .filter((item) => item.status !== 'passed')
        .map((item) => [item.id, item.status])
        .sort(),
      mode === 'faulty' ? expectedFailures.map((id) => [id, 'failed']) : [],
      `${mode}: validation did not produce the independently specified outcomes`,
    );
    assert.equal(hash(await readFile(approvalPath)), approvalHash, 'Approved expectations changed');
    results[mode] = {
      run_id: run.id,
      passed: run.cases.filter((item) => item.status === 'passed').length,
      failed: run.cases.filter((item) => item.status === 'failed').map((item) => item.id),
      report: report.html,
      traceability: report.csv,
      ...(report.pdf ? { pdf: report.pdf } : {}),
    };
    console.log(`${mode}: ${results[mode].passed} passed, ${results[mode].failed.length} failed`);
    console.log(`Report: ${report.html}`);
  }
  await writeFile(
    join(project, 'comparison.json'),
    `${JSON.stringify({ package_id: approval.package_id, approval_sha256: approvalHash, results }, null, 2)}\n`,
  );
  console.log(
    'Verified: all four seeded defects were detected; corrected mode passed the same approval.',
  );
  console.log('This comparison exits successfully when the expected failures are detected.');
} finally {
  if (app) await app.close();
  console.log(`Retained evidence: ${project}`);
}
