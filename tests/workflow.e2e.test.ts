import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { startSampleApp } from '../examples/sample-app/server.ts';
import { planSchema, ursSchema, type Bindings } from '../src/schema.js';
import { createCandidate, approveCandidate } from '../src/project.js';
import { executePackage } from '../src/runtime/index.js';
import { renderReport } from '../src/reports.js';

async function treeFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? treeFiles(join(directory, entry.name))
          : [join(directory, entry.name)],
      ),
    )
  ).flat();
}

describe('approved sample qualification workflow', () => {
  let directory: string;
  let app: Awaited<ReturnType<typeof startSampleApp>>;
  const example = resolve('examples/sample-validation');
  let bindings: Bindings;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'provenarium validation e2e '));
    app = await startSampleApp({ port: 0, dataDir: join(directory, 'target-data') });
    bindings = JSON.parse(await readFile('examples/sample-app/credentials.example.json', 'utf8'));
  });
  afterAll(async () => {
    if (app) await app.close();
    if (directory && !process.env.KEEP_E2E_ARTIFACTS)
      await rm(directory, { recursive: true, force: true });
  });

  it('retains a good run and a meaningful defect under one unchanged approval', async () => {
    const project = join(directory, 'validation project');
    const urs = ursSchema.parse(parse(await readFile(join(example, 'urs.yaml'), 'utf8')));
    const plan = planSchema.parse(JSON.parse(await readFile(join(example, 'plan.json'), 'utf8')));
    plan.target = { url: app.url, allowed_origins: [app.url] };
    const files: Record<string, Buffer> = {};
    for (const path of [...plan.fixtures, ...plan.references])
      files[path] = await readFile(join(example, path));
    await createCandidate(project, urs, plan, { files, pdf: true });
    const approval = await approveCandidate(project, { pdf: true });
    const packageDirectory = join(project, 'packages', approval.package_id);
    // A directory-discovery runner would execute this; the approval allowlist must not.
    await writeFile(
      join(packageDirectory, 'tests', 'unapproved.spec.cjs'),
      'throw new Error("UNAPPROVED TEST EXECUTED");\n',
    );
    const good = await executePackage(project, approval.package_id, {
      bindings,
      releaseLabel: 'synthetic-good',
    });
    expect(good.complete).toBe(true);
    expect(good.cases).toHaveLength(plan.cases.length);
    expect(
      good.cases.filter((result) => result.id !== 'IQ-002' && result.status !== 'passed'),
    ).toEqual([]);
    expect(good.cases.find((result) => result.id === 'IQ-002')?.status).toBe('manual_pending');
    expect(good.artifacts.length).toBeGreaterThan(10);
    const goodReport = await renderReport(project, { runId: good.id, pdf: true });
    expect(await readFile(goodReport.html, 'utf8')).toContain('URS-REC-002');
    expect((await readFile(goodReport.pdf!)).subarray(0, 5).toString()).toBe('%PDF-');
    expect(await readFile(goodReport.csv, 'utf8')).toContain('manual_pending');

    await app.resetRecords();
    app.setDefective(true);
    const defective = await executePackage(project, approval.package_id, {
      bindings,
      releaseLabel: 'synthetic-defective',
    });
    expect(defective.id).not.toBe(good.id);
    expect(defective.package_id).toBe(good.package_id);
    expect(defective.cases.find((result) => result.id === 'OQ-007')?.status).toBe('failed');
    const observations = (
      await readFile(join(project, 'runs', defective.id, 'observations.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      observations.some((record) => record.case_id === 'OQ-007' && record.status === 'failed'),
    ).toBe(true);
    const badReport = await renderReport(project, { runId: defective.id, pdf: false });
    expect(await readFile(badReport.html, 'utf8')).toContain('URS-REC-002');
    expect(
      JSON.parse(await readFile(join(project, 'runs', good.id, 'run.json'), 'utf8')).cases.find(
        (result: { id: string }) => result.id === 'OQ-007',
      ).status,
    ).toBe('passed');

    // Report assembly must mark damaged or absent evidence without revisiting the app.
    const artifact = good.artifacts[0];
    const artifactPath = join(project, 'runs', good.id, artifact.path);
    const originalArtifact = await readFile(artifactPath);
    await writeFile(artifactPath, Buffer.from('changed retained evidence'));
    const changedReport = await renderReport(project, { runId: good.id, pdf: false });
    expect(await readFile(changedReport.html, 'utf8')).toMatch(/changed|mismatch|modified/i);
    await rm(artifactPath);
    const missingReport = await renderReport(project, { runId: good.id, pdf: false });
    expect(await readFile(missingReport.html, 'utf8')).toMatch(/missing/i);
    await writeFile(artifactPath, originalArtifact);
    await renderReport(project, { runId: good.id, pdf: false });

    const compiledPath = join(packageDirectory, approval.tests[0]);
    const original = await readFile(compiledPath);
    await writeFile(
      compiledPath,
      Buffer.concat([original, Buffer.from('\n// changed after approval\n')]),
    );
    await expect(executePackage(project, approval.package_id, { bindings })).rejects.toThrow(
      /hash|changed|integrity|modified/i,
    );
    await writeFile(compiledPath, original);

    const forbidden = Object.values(bindings).flatMap((binding) =>
      [binding.password, binding.token].filter((secret): secret is string => Boolean(secret)),
    );
    for (const path of await treeFiles(project)) {
      if (path.includes(`${join('.provenarium', 'auth')}`)) continue;
      const content = (await readFile(path)).toString('utf8');
      for (const secret of forbidden)
        expect(content, `Secret leaked into ${path}`).not.toContain(secret);
    }
    expect(await readdir(project)).not.toContain('node_modules');
    if (process.env.KEEP_E2E_ARTIFACTS)
      process.stdout.write(`Qualification artifacts retained at ${project}\n`);
  }, 180000);
});
