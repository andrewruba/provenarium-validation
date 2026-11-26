import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { load } from 'cheerio';
import { observationSchema, planSchema, ursSchema } from '../src/schema.js';
import { createCandidate, approveCandidate } from '../src/project.js';
import { executePackage } from '../src/runtime/index.js';
import { renderReport } from '../src/reports.js';

let directory: string | undefined;
let server: Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  if (directory) {
    await rm(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

it('keeps observations, artifacts, and report rows separate for repeated step numbers', async () => {
  directory = await mkdtemp(join(tmpdir(), 'provenarium-step-identity-'));
  const expected = new Map([
    ['/C1/01', 'Alpha first'],
    ['/C1/02', 'Alpha second'],
    ['/C2/01', 'Bravo first'],
    ['/C2/02', 'Bravo second'],
  ]);
  server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(
      `<html><body><p data-testid="status">${expected.get(request.url ?? '') ?? 'Unknown'}</p></body></html>`,
    );
  });
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address.');
  const url = `http://127.0.0.1:${address.port}`;
  const urs = ursSchema.parse({
    schema_version: 1,
    document: {
      id: 'URS-STEPS',
      revision: '1',
      title: 'Case-specific status',
      intended_use: 'Verify independent case observations.',
    },
    families: [
      {
        id: 'status',
        title: 'Status',
        requirements: [
          { id: 'R1', title: 'Status', statement: 'Each page shall show its specified status.' },
        ],
      },
    ],
  });
  const plan = planSchema.parse({
    schema_version: 1,
    runtime_version: 1,
    id: 'PLAN-STEPS',
    title: 'Case-specific evidence',
    urs_revision: '1',
    target: { url, allowed_origins: [url] },
    environment: {},
    obligations: [
      {
        id: 'OB1',
        requirement_id: 'R1',
        source: 'R1/statement',
        statement: 'Each independent case retains its own status.',
        assertion_ids: ['A-C1-01', 'A-C1-02', 'A-C2-01', 'A-C2-02'],
      },
    ],
    cases: ['C1', 'C2'].map((caseId) => ({
      id: caseId,
      title: `Status for ${caseId}`,
      classification: 'OQ',
      requirements: ['R1'],
      steps: ['01', '02'].map((stepId) => ({
        id: stepId,
        instruction: `Observe the status for ${caseId} step ${stepId}.`,
        actions: [{ op: 'navigate', url: `/${caseId}/${stepId}` }],
        assertions: [
          {
            id: `A-${caseId}-${stepId}`,
            locator: { by: 'testId', value: 'status' },
            comparison: 'equals',
            expected: expected.get(`/${caseId}/${stepId}`),
          },
        ],
        evidence: [{ id: `E-${caseId}-${stepId}`, kind: 'screenshot' }],
      })),
    })),
  });

  await createCandidate(directory, urs, plan, { pdf: false });
  await approveCandidate(directory, { pdf: false });
  const run = await executePackage(directory, undefined, { bindings: {} });
  expect(run.complete).toBe(true);
  expect(run.cases.map((result) => result.status)).toEqual(['passed', 'passed']);
  const observations = (
    await readFile(join(directory, 'runs', run.id, 'observations.jsonl'), 'utf8')
  )
    .trim()
    .split('\n')
    .map((line) => observationSchema.parse(JSON.parse(line)));
  const assertions = observations.filter((observation) => observation.assertion_id);
  expect(assertions).toHaveLength(4);
  for (const record of assertions) {
    expect(record.assertion_id).toBe(`A-${record.case_id}-${record.step_id}`);
    expect(record.actual).toBe(expected.get(`/${record.case_id}/${record.step_id}`));
    expect(record.status).toBe('passed');
  }
  expect(run.artifacts).toHaveLength(4);
  expect(new Set(run.artifacts.map((artifact) => artifact.path)).size).toBe(4);
  for (const artifact of run.artifacts) {
    expect(artifact.id).toBe(`E-${artifact.case_id}-${artifact.step_id}`);
    expect((await readFile(join(directory, 'runs', run.id, artifact.path))).length).toBeGreaterThan(
      0,
    );
  }

  const report = await renderReport(directory, { runId: run.id, pdf: false });
  const $ = load(await readFile(report.html, 'utf8'));
  for (const caseId of ['C1', 'C2']) {
    const rows = $('h3')
      .filter((_index, element) => $(element).text() === `${caseId} — Status for ${caseId}`)
      .next('table')
      .find('tbody tr');
    expect(rows.length).toBe(2);
    rows.each((_index, row) => {
      const cells = $(row).find('td');
      const stepId = cells.eq(0).text();
      const actual = cells.eq(3).text();
      expect(actual).toContain(expected.get(`/${caseId}/${stepId}`));
      expect(actual).toContain(`A-${caseId}-${stepId}`);
      expect(actual).toContain(`E-${caseId}-${stepId}`);
      expect(actual).not.toContain(caseId === 'C1' ? 'Bravo' : 'Alpha');
      expect(actual).not.toContain(`A-${caseId === 'C1' ? 'C2' : 'C1'}-`);
    });
  }
});
