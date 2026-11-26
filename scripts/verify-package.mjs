#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
const archiveSha256 = createHash('sha256')
  .update(await readFile(archive))
  .digest('hex');
const workspace = await mkdtemp(join(tmpdir(), 'provenarium package verification '));
const prefix = join(workspace, 'installation prefix');
const globalPrefix = join(workspace, 'global installation prefix');
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
  const dependencyLock = JSON.parse(await readFile(join(installed, 'npm-shrinkwrap.json'), 'utf8'));
  assert.equal(dependencyLock.name, packageInfo.name);
  assert.equal(dependencyLock.version, packageInfo.version);
  assert.deepEqual(dependencyLock.packages[''].dependencies, packageInfo.dependencies);
  const localCli = join(installed, 'bin', 'provenarium.mjs');
  assert.equal(
    execFileSync(process.execPath, [localCli, '--version'], { encoding: 'utf8' }).trim(),
    packageInfo.version,
  );
  execFileSync(process.execPath, [localCli, 'browser', 'install'], {
    cwd: workspace,
    stdio: 'inherit',
  });

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

  // Exercise the actual executable and removal command in an isolated npm global
  // prefix. Never install into or uninstall from the developer's real prefix.
  execFileSync('npm', ['install', '--global', '--prefix', globalPrefix, archive], {
    stdio: 'inherit',
  });
  const globalCli = join(globalPrefix, 'bin', 'provenarium');
  const globalPackage = join(globalPrefix, 'lib', 'node_modules', packageInfo.name);
  const sentinel = join(globalPrefix, 'unrelated-data.txt');
  await writeFile(sentinel, 'preserve unrelated files\n');
  const unrelatedPackage = join(globalPrefix, 'lib', 'node_modules', 'unrelated-fixture');
  await mkdir(unrelatedPackage, { recursive: true });
  await writeFile(
    join(unrelatedPackage, 'package.json'),
    JSON.stringify({ name: 'unrelated-fixture', version: '1.0.0' }),
  );
  const cliEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'npm_config_prefix'),
  );
  cliEnv.npm_config_prefix = globalPrefix;
  const cliOptions = { env: cliEnv, cwd: workspace, encoding: 'utf8' };
  assert.equal(execFileSync(globalCli, ['--version'], cliOptions).trim(), packageInfo.version);
  assert.match(execFileSync(globalCli, ['--help'], cliOptions), /uninstall/);
  execFileSync(globalCli, ['browser', 'install'], { ...cliOptions, stdio: 'inherit' });
  const dryRun = execFileSync(globalCli, ['uninstall', '--dry-run'], cliOptions);
  assert.ok(dryRun.includes(globalPrefix), 'Dry run did not identify the isolated prefix');
  await access(globalPackage);
  // Local installation and unattended removal without consent must fail before
  // changing any package, even when a matching global installation exists.
  assert.throws(() =>
    execFileSync(process.execPath, [localCli, 'uninstall', '--yes'], {
      ...cliOptions,
      stdio: 'pipe',
    }),
  );
  await access(localCli);
  assert.throws(() => execFileSync(globalCli, ['uninstall'], { ...cliOptions, stdio: 'pipe' }));
  await access(globalPackage);
  execFileSync(globalCli, ['uninstall', '--yes'], { ...cliOptions, stdio: 'inherit' });
  await assert.rejects(access(globalPackage), { code: 'ENOENT' });
  await assert.rejects(access(globalCli), { code: 'ENOENT' });
  assert.equal(await readFile(sentinel, 'utf8'), 'preserve unrelated files\n');
  await access(join(unrelatedPackage, 'package.json'));
  assert.equal(hash(await readFile(approvalPath)), originalApprovalHash);
  await access(goodReport.html);
  await access(defectiveReport.html);
  assert.equal(
    createHash('sha256')
      .update(await readFile(archive))
      .digest('hex'),
    archiveSha256,
    'Release archive changed during verification',
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
    archive_sha256: archiveSha256,
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    package_id: approval.package_id,
    good: counts(good),
    defective: counts(defective),
    project_has_node_modules: false,
    browser_install: 'passed',
    global_install_uninstall: 'passed',
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
