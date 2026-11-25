#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const keep = args.includes('--keep') || process.env.KEEP_PACKAGE_ARTIFACTS === '1';
const positional = args.filter((argument) => argument !== '--keep');
if (positional.length > 1 || positional.some((argument) => argument.startsWith('--'))) {
  throw new Error('Usage: node scripts/verify-package.mjs [archive.tgz] [--keep]');
}
let archive = positional[0];
if (!archive) {
  const records = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--ignore-scripts'], { encoding: 'utf8' }),
  );
  archive = records[0].filename;
}
archive = resolve(archive);
const workspace = await mkdtemp(join(tmpdir(), 'provenarium package verification '));
const prefix = join(workspace, 'installation prefix');
const project = join(workspace, 'independent validation project');
let app;
try {
  execFileSync('npm', ['install', '--prefix', prefix, archive], { stdio: 'inherit' });
  const requireInstalled = createRequire(join(prefix, 'package.json'));
  const main = requireInstalled.resolve('provenarium-validation');
  const installed = resolve(main, '..', '..');
  const { loadUrs, planSchema, createCandidate, approveCandidate, renderReport } = await import(
    pathToFileURL(main).href
  );
  const { executePackage } = await import(
    pathToFileURL(requireInstalled.resolve('provenarium-validation/runtime')).href
  );
  const packageInfo = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(packageInfo.name, 'provenarium-validation');

  const { startSampleApp } = await import(
    pathToFileURL(requireInstalled.resolve('provenarium-validation/example')).href
  );
  app = await startSampleApp({ port: 0, dataDir: join(workspace, 'target data') });
  const example = join(installed, 'examples', 'sample-validation');
  const urs = await loadUrs(join(example, 'urs.yaml'));
  const plan = planSchema.parse(JSON.parse(await readFile(join(example, 'plan.json'), 'utf8')));
  plan.target = { url: app.url, allowed_origins: [app.url] };
  const files = {};
  for (const relative of [...plan.fixtures, ...plan.references])
    files[relative] = await readFile(join(example, relative));
  const bindings = JSON.parse(
    await readFile(join(installed, 'examples', 'sample-app', 'credentials.example.json'), 'utf8'),
  );
  await createCandidate(project, urs, plan, { files, pdf: true });
  const approval = await approveCandidate(project, { pdf: true });
  const approvalPath = join(project, 'packages', approval.package_id, 'approval.json');
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const originalApprovalHash = hash(await readFile(approvalPath));
  const good = await executePackage(project, approval.package_id, {
    bindings,
    releaseLabel: 'clean-install-good',
  });
  assert.equal(good.complete, true, 'Good qualification did not complete');
  assert.deepEqual(
    good.cases.filter((result) => !['passed', 'manual_pending'].includes(result.status)),
    [],
    'Good qualification has unsuccessful automated cases',
  );
  assert.equal(good.cases.length, plan.cases.length);
  assert.ok(good.artifacts.length > 0, 'Good qualification retained no artifacts');
  const goodReport = await renderReport(project, { runId: good.id, pdf: true });
  assert.equal((await readFile(goodReport.pdf)).subarray(0, 5).toString(), '%PDF-');
  assert.match(await readFile(goodReport.csv, 'utf8'), /manual_pending/);

  await app.resetRecords();
  app.setDefective(true);
  const defective = await executePackage(project, approval.package_id, {
    bindings,
    releaseLabel: 'clean-install-defective',
  });
  assert.equal(defective.package_id, good.package_id);
  assert.notEqual(defective.id, good.id);
  assert.equal(
    defective.cases.find((result) => result.id === 'OQ-007')?.status,
    'failed',
    'The deliberate duplicate defect was not detected',
  );
  const defectiveReport = await renderReport(project, { runId: defective.id, pdf: true });
  assert.match(await readFile(defectiveReport.html, 'utf8'), /URS-REC-002/);
  assert.equal(
    hash(await readFile(approvalPath)),
    originalApprovalHash,
    'Approved expectations changed between variants',
  );
  assert.equal(
    (await readdir(project)).includes('node_modules'),
    false,
    'Validation project installed runtime dependencies',
  );

  const counts = (run) =>
    Object.fromEntries(
      ['passed', 'failed', 'blocked', 'not_run', 'manual_pending'].map((status) => [
        status,
        run.cases.filter((result) => result.status === status).length,
      ]),
    );
  const result = {
    package: `${packageInfo.name}@${packageInfo.version}`,
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    package_id: approval.package_id,
    good: counts(good),
    defective: counts(defective),
    project_has_node_modules: false,
    good_report: goodReport.html,
    defective_report: defectiveReport.html,
  };
  await writeFile(join(workspace, 'verification.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Clean package workflow passed: ${JSON.stringify(result)}`);
} finally {
  if (app) await app.close();
  if (keep) console.log(`Package verification artifacts: ${workspace}`);
  else await rm(workspace, { recursive: true, force: true });
}
