import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startDilutionApp } from '../examples/dilution-app/server.js';
import { validateHostedDilution } from '../scripts/validate-hosted-dilution.mjs';

let root: string;
let faulty: Awaited<ReturnType<typeof startDilutionApp>>;
let correct: Awaited<ReturnType<typeof startDilutionApp>>;
const commit = 'a'.repeat(40);
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'hosted dilution CLI '));
  faulty = await startDilutionApp({ port: 0, commit });
  correct = await startDilutionApp({ port: 0, defects: [], commit });
});
afterAll(async () => {
  if (faulty) await faulty.close();
  if (correct) await correct.close();
  if (root) await rm(root, { recursive: true, force: true });
});

it('uses the actual CLI to validate two isolated hosted targets and retain their evidence', async () => {
  const comparison = await validateHostedDilution({
    correctUrl: correct.url,
    faultyUrl: faulty.url,
    output: root,
    commit,
    log: () => {},
  });
  expect(comparison.complete).toBe(true);
  expect(comparison.results.faulty.cli_exit).toBe(1);
  expect(comparison.results.faulty.passed).toBe(7);
  expect(comparison.results.faulty.failed).toHaveLength(4);
  expect(comparison.results.correct.cli_exit).toBe(0);
  expect(comparison.results.correct.passed).toBe(11);
  expect(comparison.results.correct.failed).toEqual([]);
  expect(comparison.results.correct.package_id).not.toBe(comparison.results.faulty.package_id);
  expect(comparison.results.correct.protocol_source_sha256).toBe(
    comparison.results.faulty.protocol_source_sha256,
  );
  for (const mode of ['faulty', 'correct']) {
    const result = comparison.results[mode];
    expect(result.target_url).toContain('/w/');
    expect(result.deployed_commit).toBe(commit);
    expect(await readFile(result.report, 'utf8')).toContain('URS-CALC-001');
    const log = await readFile(join(result.project, 'cli.log'), 'utf8');
    for (const command of ['generate', 'approve', 'run', 'report'])
      expect(log).toContain(`$ provenarium ${command}`);
    // Neither browser visitors nor the other hosted target share this run's records.
    const application = mode === 'correct' ? correct : faulty;
    expect((await (await fetch(`${application.url}/api/plans`)).json()).plans).toEqual([]);
  }
}, 180000);
