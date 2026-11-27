#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { preparePagesDilution, repository, variantUrl } from './prepare-pages-dilution.mjs';

const expectedFailures = [
  'OQ-UNIT-CONVERSION',
  'OQ-ZERO-VOLUME',
  'OQ-DUPLICATE-ID',
  'OQ-CSV-EXPORT',
].sort();
const digest = (value) => createHash('sha256').update(value).digest('hex');

/** Deployment metadata is a readiness check, separate from the browser qualification. */
export async function readVersion(url, { mode, commit } = {}) {
  const response = await fetch(new URL('version.json', variantUrl(url)), {
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Deployment metadata returned HTTP ${response.status}.`);
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
        if (size > 16384) {
          await reader.cancel();
          throw new Error('Deployment metadata exceeded 16 KiB.');
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  let version;
  try {
    version = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Deployment metadata did not contain JSON.');
  }
  if (
    version?.application !== 'Dilution Bench' ||
    typeof version.commit !== 'string' ||
    !/^[a-f0-9]{40}$/i.test(version.commit)
  )
    throw new Error('Deployment metadata must identify Dilution Bench and a full Git commit SHA.');
  if (version.mode !== mode) throw new Error(`Expected the ${mode} application variant.`);
  if (commit && version.commit !== commit)
    throw new Error('The deployed commit does not match the requested revision.');
  return version;
}

export async function validatePagesDilution({
  correctUrl,
  faultyUrl,
  output,
  commit,
  pdf = false,
  log = console.log,
}) {
  // Validate every destination before making network requests or writing projects.
  const urls = { faulty: variantUrl(faultyUrl), correct: variantUrl(correctUrl) };
  if (urls.faulty === urls.correct)
    throw new Error('Faulty and corrected variants must have different URLs.');
  if (commit !== undefined && !/^[a-f0-9]{40}$/i.test(commit))
    throw new Error('Expected commit must be a full 40-character hexadecimal Git SHA.');
  const { loadUrs, createCandidate, approveCandidate, renderReport } =
    await import('../dist/index.js');
  const { executePackage } = await import('../dist/runtime/index.js');
  const base = resolve(output ?? join(repository, '.demo-results', 'pages-dilution'));
  await mkdir(base, { recursive: true });
  const comparison = await mkdtemp(join(base, 'comparison-'));
  const results = {};
  const metadata = { schema_version: 1, complete: false, results };
  const document = join(comparison, 'comparison.json');
  log(`Pages validation evidence: ${comparison}`);
  try {
    for (const [mode, url] of Object.entries(urls)) {
      const prepared = await preparePagesDilution({ url, project: join(comparison, mode) });
      log(`Checking ${mode} page: ${prepared.target.target_url}`);
      const initialVersion = await readVersion(url, { mode, commit });
      const requirements = await loadUrs(join(prepared.project, 'urs.yaml'));
      await createCandidate(prepared.project, requirements, prepared.plan, { pdf });
      const approval = await approveCandidate(prepared.project, { pdf });
      const approvalPath = join(prepared.project, 'packages', approval.package_id, 'approval.json');
      const approvalHash = digest(await readFile(approvalPath));
      log(`Running prepared ${mode} fixture ...`);
      const run = await executePackage(prepared.project, approval.package_id, {
        releaseLabel: `pages-dilution-${mode}`,
      });
      const report = await renderReport(prepared.project, { runId: run.id, pdf });
      results[mode] = {
        project: prepared.project,
        target_url: prepared.target.target_url,
        deployed_commit: initialVersion.commit ?? null,
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
      const afterVersion = await readVersion(url, { mode, commit });
      assert.equal(
        afterVersion.commit,
        initialVersion.commit,
        `${mode}: deployment changed during qualification.`,
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({
      options: {
        'correct-url': { type: 'string' },
        'faulty-url': { type: 'string' },
        output: { type: 'string' },
        commit: { type: 'string' },
        pdf: { type: 'boolean', default: false },
        help: { type: 'boolean' },
      },
    });
    if (values.help) {
      console.log(
        'Usage: node scripts/validate-pages-dilution.mjs --correct-url <variant-url> --faulty-url <variant-url> [--output <parent-directory>] [--commit <40-character-sha>] [--pdf]',
      );
    } else {
      await validatePagesDilution({
        correctUrl: values['correct-url'],
        faultyUrl: values['faulty-url'],
        output: values.output,
        commit: values.commit,
        pdf: values.pdf,
      });
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
