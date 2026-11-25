#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { parse } from 'yaml';
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

async function cli(project, args, logs) {
  const command = [join(repository, 'bin', 'provenarium.mjs'), '--project', project, ...args];
  logs.push(`\n$ provenarium ${args.join(' ')}\n`);
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, command, {
      cwd: repository,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180000,
    });
    let length = 0;
    const collect = (data) => {
      length += data.length;
      if (length > 4 * 1024 * 1024) {
        child.kill();
        return;
      }
      logs.push(data.toString('utf8'));
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal || code === null)
        reject(new Error(`CLI ${args[0]} was interrupted or timed out.`));
      else resolveExit(code);
    });
  });
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
      const logs = [];
      try {
        log(`Warming ${mode} service: ${prepared.target.target_url}`);
        const initialHealth = await waitForHealth(prepared.target, { mode, commit });
        const renderOptions = pdf ? [] : ['--no-pdf'];
        const generate = await cli(
          prepared.project,
          ['generate', '--urs', 'urs.yaml', '--plan', 'plan.json', ...renderOptions],
          logs,
        );
        assert.equal(generate, 0, `${mode}: CLI generation failed; see cli.log.`);
        const approve = await cli(prepared.project, ['approve', '--yes', ...renderOptions], logs);
        assert.equal(approve, 0, `${mode}: CLI approval failed; see cli.log.`);
        let config = parse(await readFile(join(prepared.project, 'provenarium.yaml'), 'utf8'));
        assert.ok(
          typeof config.current_package === 'string',
          'CLI did not select an approved package.',
        );
        const approvalPath = join(
          prepared.project,
          'packages',
          config.current_package,
          'approval.json',
        );
        const approvalHash = digest(await readFile(approvalPath));
        log(`Running main CLI against ${mode} mode ...`);
        const runExit = await cli(
          prepared.project,
          ['run', '--release-label', `hosted-dilution-${mode}`],
          logs,
        );
        // Report a failed run before asserting the expected failure inventory.
        const reportExit = await cli(prepared.project, ['report', ...renderOptions], logs);
        assert.equal(reportExit, 0, `${mode}: CLI report failed; see cli.log.`);
        config = parse(await readFile(join(prepared.project, 'provenarium.yaml'), 'utf8'));
        assert.ok(typeof config.last_run === 'string', 'CLI did not retain a qualification run.');
        const run = JSON.parse(
          await readFile(join(prepared.project, 'runs', config.last_run, 'run.json'), 'utf8'),
        );
        const reportDirectory = join(prepared.project, 'runs', run.id, 'reports');
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
          cli_exit: runExit,
          passed: run.cases.filter((item) => item.status === 'passed').length,
          failed: run.cases.filter((item) => item.status === 'failed').map((item) => item.id),
          report: join(reportDirectory, 'executed-record.html'),
          traceability: join(reportDirectory, 'traceability.csv'),
          ...(pdf ? { pdf: join(reportDirectory, 'executed-record.pdf') } : {}),
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
        assert.equal(
          run.package_id,
          config.current_package,
          `${mode}: unexpected approved package.`,
        );
        assert.equal(run.target_url, prepared.target.target_url, `${mode}: wrong target recorded.`);
        assert.equal(runExit, mode === 'faulty' ? 1 : 0, `${mode}: unexpected CLI exit status.`);
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
      } finally {
        await writeFile(join(prepared.project, 'cli.log'), logs.join(''));
      }
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
        'Usage: node scripts/validate-hosted-dilution.mjs --correct-url <origin> --faulty-url <origin> [--output <parent-directory>] [--commit <40-character-sha>] [--pdf]',
      );
    } else {
      await validateHostedDilution({
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
