import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { planSchema, ursSchema } from '../src/schema.js';
import { createCandidate, approveCandidate } from '../src/project.js';
import { executePackage } from '../src/runtime/index.js';

let root: string | undefined;
let server: Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

it('checks downloaded CSV cells while retaining original bytes and approved expected values', async () => {
  root = await mkdtemp(join(tmpdir(), 'provenarium-csv-download-'));
  let csv = '\uFEFF"Sample ID","Volume (mL)"\r\n"A","1.250"\r\n';
  server = createServer((request, response) => {
    if (request.url === '/export.csv') {
      response.setHeader('content-type', 'text/csv; charset=utf-8');
      response.setHeader('content-disposition', 'attachment; filename="preparations.csv"');
      response.end(csv);
    } else {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end('<!doctype html><a href="/export.csv" download>Download CSV</a>');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No CSV server address.');
  const url = `http://127.0.0.1:${address.port}`;
  const urs = ursSchema.parse({
    schema_version: 1,
    document: {
      id: 'URS-CSV',
      revision: '1',
      title: 'CSV export',
      intended_use: 'Retain and check preparation exports.',
    },
    families: [
      {
        id: 'exports',
        title: 'Exports',
        requirements: [
          {
            id: 'R-CSV',
            title: 'Preparation export',
            statement: 'Export the saved preparation with its three-decimal volume.',
          },
        ],
      },
    ],
  });
  const plan = planSchema.parse({
    schema_version: 1,
    runtime_version: 1,
    id: 'PLAN-CSV',
    title: 'CSV qualification',
    urs_revision: '1',
    target: { url, allowed_origins: [url] },
    environment: {},
    obligations: [
      {
        id: 'OB-CSV',
        requirement_id: 'R-CSV',
        source: 'R-CSV/statement',
        statement: 'CSV contains the required headers and exact preparation values.',
        assertion_ids: ['A-CSV'],
      },
    ],
    cases: [
      {
        id: 'C-CSV',
        title: 'Download the preparation',
        classification: 'OQ',
        requirements: ['R-CSV'],
        steps: [
          {
            id: 'S-CSV',
            instruction: 'Download CSV and compare exact cells, including numeric formatting.',
            actions: [
              { op: 'navigate', url: '/' },
              {
                op: 'download',
                locator: { by: 'role', role: 'link', value: 'Download CSV' },
                save_as: 'export',
              },
            ],
            assertions: [
              {
                id: 'A-CSV',
                variable: 'export.text',
                comparison: 'csv_equals',
                expected: [
                  ['Sample ID', 'Volume (mL)'],
                  ['A', '1.250'],
                ],
              },
            ],
            evidence: [{ id: 'E-CSV', kind: 'download', variable: 'export' }],
          },
        ],
      },
    ],
  });
  await createCandidate(root, urs, plan, { pdf: false });
  const approval = await approveCandidate(root, { pdf: false });
  const approvalFile = join(root, 'packages', approval.package_id, 'approval.json');
  const approved = await readFile(approvalFile);
  const passing = await executePackage(root, approval.package_id, { bindings: {} });
  expect(passing.cases[0].status).toBe('passed');
  const artifact = passing.artifacts.find((value) => value.kind === 'download');
  expect(artifact).toBeDefined();
  const downloaded = await readFile(join(root, 'runs', passing.id, artifact!.path));
  expect(downloaded).toEqual(Buffer.from(csv));
  expect(artifact!.sha256).toBe(createHash('sha256').update(downloaded).digest('hex'));
  const observations = await readFile(join(root, 'runs', passing.id, 'observations.jsonl'), 'utf8');
  const assertion = observations
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((value) => value.assertion_id === 'A-CSV');
  expect(assertion.actual).toBe(csv);
  expect(assertion.expected).toEqual(plan.cases[0].steps[0].assertions[0].expected);

  csv = 'Sample ID,Volume (mL)\nA,1.25\n';
  const failing = await executePackage(root, approval.package_id, { bindings: {} });
  expect(failing.cases[0].status).toBe('failed');
  expect(await readFile(approvalFile)).toEqual(approved);
});
