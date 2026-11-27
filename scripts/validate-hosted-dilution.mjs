import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareDilution, repository, serviceOrigin } from './prepare-dilution.mjs';

const expectedFailures = [
  'OQ-UNIT-CONVERSION',
  'OQ-ZERO-VOLUME',
  'OQ-DUPLICATE-ID',
  'OQ-CSV-EXPORT',
].sort();
const digest = (value) => createHash('sha256').update(value).digest('hex');

async function readHealth(target, timeoutMs) {
  const response = await fetch(new URL('health', target.target_url), {
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Health endpoint returned HTTP ${response.status}.`);
  }
  const reader = response.body?.getReader();
  const chunks = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 16 * 1024) {
          await reader.cancel();
          throw new Error('Health response exceeded 16 KiB.');
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  let health;
  try {
    health = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Health endpoint did not return JSON; the service may still be starting.');
  }
  if (health.status !== 'ok' || health.application !== 'Dilution Bench')
    throw new Error('The service is not a healthy Dilution Bench instance.');
  const workspace = response.headers.get('x-dilution-workspace');
  const generation = response.headers.get('x-dilution-generation');
  if (workspace !== target.workspace || !generation || !/^[A-Za-z0-9_-]{8,100}$/.test(generation))
    throw new Error('The service does not identify the expected isolated workspace generation.');
  return { ...health, generation };
}

/** Free services can cold-start; retry only readiness, never a qualification command. */
export async function waitForHealth(target, { mode, commit, timeoutMs = 120000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let reason = 'The service did not become ready.';
  while (Date.now() < deadline) {
    try {
      const health = await readHealth(target, Math.max(1, Math.min(10000, deadline - Date.now())));
      if (mode && health.mode !== mode) throw new Error(`Waiting for ${mode} application mode.`);
      if (commit && health.commit !== commit)
        throw new Error('Waiting for the requested deployment commit.');
      return health;
    } catch (error) {
      reason = error instanceof Error ? error.message : 'Health request failed.';
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(3000, remaining));
  }
  throw new Error(`Service readiness timed out: ${reason}`);
}

export async function validateHostedDilution({
  correctUrl,
  faultyUrl,
  output,
  commit,
  pdf = false,
  log = console.log,
}) {
  // Validate every destination before making network requests or writing projects.
  const urls = { faulty: serviceOrigin(faultyUrl), correct: serviceOrigin(correctUrl) };
  if (urls.faulty === urls.correct)
    throw new Error('Faulty and corrected services must have different origins.');
  if (commit !== undefined && !/^[a-f0-9]{40}$/i.test(commit))
    throw new Error('Expected commit must be a full 40-character hexadecimal Git SHA.');
  const { loadUrs, createCandidate, approveCandidate, renderReport } =
    await import('../dist/index.js');
  const { executePackage } = await import('../dist/runtime/index.js');
  const base = resolve(output ?? join(repository, '.demo-results', 'hosted-dilution'));
  await mkdir(base, { recursive: true });
  const comparison = await mkdtemp(join(base, 'comparison-'));
  const results = {};
  const metadata = { schema_version: 1, complete: false, results };
  const document = join(comparison, 'comparison.json');
  log(`Hosted validation evidence: ${comparison}`);
  try {
    for (const [mode, url] of Object.entries(urls)) {
      const prepared = await prepareDilution({ url, project: join(comparison, mode) });
      log(`Warming ${mode} service: ${prepared.target.target_url}`);
      const initialHealth = await waitForHealth(prepared.target, { mode, commit });
      const requirements = await loadUrs(join(prepared.project, 'urs.yaml'));
      await createCandidate(prepared.project, requirements, prepared.plan, { pdf });
      const approval = await approveCandidate(prepared.project, { pdf });
      const approvalPath = join(prepared.project, 'packages', approval.package_id, 'approval.json');
      const approvalHash = digest(await readFile(approvalPath));
      log(`Running prepared ${mode} fixture ...`);
      const run = await executePackage(prepared.project, approval.package_id, {
        releaseLabel: `hosted-dilution-${mode}`,
      });
      const report = await renderReport(prepared.project, { runId: run.id, pdf });
      results[mode] = {
        project: prepared.project,
        target_url: prepared.target.target_url,
        workspace_generation: initialHealth.generation,
        deployed_commit: initialHealth.commit ?? null,
        package_id: run.package_id,
        approval_sha256: approvalHash,
        protocol_source_sha256: prepared.target.protocol_source_sha256,
        requirements_source_sha256: prepared.target.requirements_source_sha256,
        run_id: run.id,
        passed: run.cases.filter((item) => item.status === 'passed').length,
        failed: run.cases.filter((item) => item.status === 'failed').map((item) => item.id),
        report: report.html,
        traceability: report.csv,
        ...(report.pdf ? { pdf: report.pdf } : {}),
      };
      await writeFile(document, `${JSON.stringify(metadata, null, 2)}\n`);
      const afterHealth = await waitForHealth(prepared.target, {
        mode,
        commit,
        timeoutMs: 15000,
      });
      assert.equal(
        afterHealth.generation,
        initialHealth.generation,
        `${mode}: workspace reset or service restarted during qualification.`,
      );
      assert.equal(
        afterHealth.commit,
        initialHealth.commit,
        `${mode}: deployed commit changed during qualification.`,
      );
      assert.equal(run.complete, true, `${mode}: run was interrupted.`);
      assert.equal(
        run.cases.length,
        prepared.plan.cases.length,
        `${mode}: case inventory changed.`,
      );
      assert.equal(run.package_id, approval.package_id, `${mode}: unexpected approved package.`);
      assert.equal(run.target_url, prepared.target.target_url, `${mode}: wrong target recorded.`);
      assert.deepEqual(
        run.cases
          .filter((item) => item.status !== 'passed')
          .map((item) => [item.id, item.status])
          .sort(),
        mode === 'faulty' ? expectedFailures.map((id) => [id, 'failed']) : [],
        `${mode}: unexpected qualification outcomes; inspect the retained report.`,
      );
      assert.equal(
        digest(await readFile(approvalPath)),
        approvalHash,
        `${mode}: approved expectations changed.`,
      );
      log(
        `${mode}: ${results[mode].passed} passed, ${results[mode].failed.length} failed\nReport: ${results[mode].report}`,
      );
    }
    assert.equal(results.faulty.protocol_source_sha256, results.correct.protocol_source_sha256);
    assert.equal(
      results.faulty.requirements_source_sha256,
      results.correct.requirements_source_sha256,
    );
    metadata.complete = true;
    log(
      'Verified all four expected faults and a fully passing corrected service. Each target has its own approval.',
    );
    return { directory: comparison, ...metadata };
  } finally {
    await writeFile(document, `${JSON.stringify(metadata, null, 2)}\n`);
    log(`Retained comparison: ${document}`);
  }
}
