import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { checkPlanInBrowser } from '../src/authoring/rehearsal.js';
import { planSchema } from '../src/schema.js';

it('repairs one confirmed ambiguous action and still reports a requirement mismatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'provenarium-guided-dry-run-'));
  let savedMessage = 'Saved successfully';
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><title>Records</title>
      <button id="save">Save</button><button id="save-copy">Save a copy</button>
      <p role="status" id="result"></p>
      <script>
        document.querySelector('#save').onclick = () => { document.querySelector('#result').textContent = ${JSON.stringify(savedMessage)}; };
        document.querySelector('#save-copy').onclick = () => { document.querySelector('#result').textContent = 'Copied'; };
      </script>`);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test HTTP server did not start.');
    const url = `http://127.0.0.1:${address.port}`;
    const plan = planSchema.parse({
      schema_version: 1,
      runtime_version: 1,
      id: 'PLAN',
      title: 'Save a synthetic test record',
      urs_revision: '1',
      target: { url, allowed_origins: [url] },
      environment: { timeout_ms: 1000 },
      obligations: [
        {
          id: 'OB-1',
          requirement_id: 'R-1',
          source: 'R-1/statement',
          statement: 'Saving reports success.',
          assertion_ids: ['A-1'],
        },
      ],
      cases: [
        {
          id: 'OQ-1',
          title: 'Save the record',
          classification: 'OQ',
          requirements: ['R-1'],
          steps: [
            {
              id: '01',
              instruction: 'Save the record and check its status.',
              actions: [
                { op: 'navigate', url: '/' },
                {
                  op: 'click',
                  locator: { by: 'role', role: 'button', value: 'Save', exact: false },
                },
              ],
              assertions: [
                {
                  id: 'A-1',
                  locator: { by: 'css', value: '#result' },
                  read: 'text',
                  comparison: 'equals',
                  expected: 'Saved successfully',
                },
              ],
            },
          ],
        },
      ],
    });
    const progress: string[] = [];
    const repaired = await checkPlanInBrowser(root, plan, [], {}, undefined, (message) =>
      progress.push(message),
    );
    expect(repaired.rehearsalBeforeRepair?.cases[0].status).toBe('failed');
    expect(repaired.rehearsalBeforeRepair?.action_issues).toEqual([
      {
        case_id: 'OQ-1',
        step_id: '01',
        action_index: 1,
        operation: 'click',
        reason: 'locator_ambiguous',
        exact_match_available: true,
      },
    ]);
    expect(repaired.rehearsal.cases).toEqual([{ id: 'OQ-1', status: 'passed' }]);
    expect(repaired.rehearsal.plan_sha256).toBe(
      createHash('sha256').update(JSON.stringify(repaired.plan)).digest('hex'),
    );
    expect(repaired.plan.cases[0].steps[0].assertions).toEqual(plan.cases[0].steps[0].assertions);
    expect(repaired.plan.obligations).toEqual(plan.obligations);
    expect(plan.cases[0].steps[0].actions[1]).toMatchObject({ locator: { exact: false } });
    expect(repaired.plan.cases[0].steps[0].actions[1]).toMatchObject({ locator: { exact: true } });
    expect(progress).toHaveLength(1);

    savedMessage = 'The record could not be saved';
    const mismatch = await checkPlanInBrowser(root, repaired.plan, []);
    expect(mismatch.plan).toBe(repaired.plan);
    expect(mismatch.rehearsalBeforeRepair).toBeUndefined();
    expect(mismatch.rehearsal.action_issues).toBeUndefined();
    expect(mismatch.rehearsal.observations).toContainEqual(
      expect.objectContaining({
        assertion_id: 'A-1',
        status: 'failed',
        expected: 'Saved successfully',
        actual: savedMessage,
      }),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
