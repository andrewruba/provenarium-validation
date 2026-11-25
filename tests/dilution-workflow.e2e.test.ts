import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startDilutionApp, allDefects, type Defect } from '../examples/dilution-app/server.js';
import { loadUrs } from '../src/urs.js';
import { planSchema } from '../src/schema.js';
import { approveCandidate, createCandidate } from '../src/project.js';
import { executePackage } from '../src/runtime/index.js';
import { renderReport } from '../src/reports.js';

let directory: string;
let app: Awaited<ReturnType<typeof startDilutionApp>>;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dilution validation '));
  app = await startDilutionApp({ port: 0, defects: [] });
});
afterAll(async () => {
  if (app) await app.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('detects each scientific defect independently without changing approved expectations', async () => {
  const fixture = resolve('examples/dilution-validation');
  const urs = await loadUrs(join(fixture, 'urs.yaml'));
  const plan = planSchema.parse(JSON.parse(await readFile(join(fixture, 'plan.json'), 'utf8')));
  plan.target = { url: app.url, allowed_origins: [app.url] };
  const files: Record<string, Buffer> = {};
  for (const name of [...plan.fixtures, ...plan.references])
    files[name] = await readFile(join(fixture, name));
  await createCandidate(directory, urs, plan, { files, pdf: false });
  const approval = await approveCandidate(directory, { pdf: false });
  const approvalPath = join(directory, 'packages', approval.package_id, 'approval.json');
  const hash = async () =>
    createHash('sha256')
      .update(await readFile(approvalPath))
      .digest('hex');
  const originalHash = await hash();
  const failures: Record<Defect, string> = {
    'concentration-units': 'OQ-UNIT-CONVERSION',
    'zero-volume': 'OQ-ZERO-VOLUME',
    'duplicate-id': 'OQ-DUPLICATE-ID',
    'csv-units': 'OQ-CSV-EXPORT',
  };
  for (const defects of [[], ...allDefects.map((defect) => [defect])]) {
    await app.resetRecords();
    app.setDefects(defects);
    const run = await executePackage(directory, approval.package_id, {
      bindings: {},
      releaseLabel: defects.join(',') || 'correct',
    });
    expect(run.complete).toBe(true);
    expect(run.cases).toHaveLength(plan.cases.length);
    expect(
      run.cases.filter((item) => item.status !== 'passed').map((item) => [item.id, item.status]),
    ).toEqual(defects.map((defect) => [failures[defect], 'failed']));
    expect(await hash()).toBe(originalHash);
    if (defects.length) {
      const observations = (
        await readFile(join(directory, 'runs', run.id, 'observations.jsonl'), 'utf8')
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(
        observations.some(
          (record) => record.case_id === failures[defects[0]] && record.status === 'failed',
        ),
      ).toBe(true);
      const report = await renderReport(directory, { runId: run.id, pdf: false });
      expect(await readFile(report.html, 'utf8')).toContain(failures[defects[0]]);
    }
  }
}, 240000);
