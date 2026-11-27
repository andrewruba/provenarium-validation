import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { z } from 'zod';
import { checkPlanInBrowser } from '../src/authoring/rehearsal.js';
import { planSchema, type LocatorSpec, type caseSchema } from '../src/schema.js';

type CaseInput = z.input<typeof caseSchema>;
const encodedAlert: LocatorSpec = {
  by: 'role',
  role: 'alert',
  value: '#messages [role=alert]',
  exact: false,
};
const correctAlert: LocatorSpec = { by: 'css', value: encodedAlert.value, exact: true };
const expectedDuplicate = 'Sample ID already exists.';
const duplicateMarkup = (message = expectedDuplicate) =>
  `<div id="messages"><p role="alert">${message}</p></div>`;
const volumeMessage = 'Final volume must be a finite number.';
const namedVolumeAlert: LocatorSpec = {
  by: 'role',
  role: 'alert',
  value: 'final VOLUME',
  exact: false,
};

const saveCase: CaseInput = {
  id: 'OQ-SAVE',
  title: 'Save a record',
  classification: 'OQ',
  requirements: ['R-1'],
  steps: [
    {
      id: '01',
      instruction: 'Save the record and check its status.',
      actions: [
        { op: 'navigate', url: '/save' },
        { op: 'click', locator: { by: 'role', role: 'button', value: 'Save', exact: false } },
      ],
      assertions: [
        {
          id: 'A-SAVE',
          locator: { by: 'css', value: '#result' },
          read: 'text',
          comparison: 'equals',
          expected: 'Saved successfully',
        },
      ],
    },
  ],
};
const saveMarkup = `<button id="save">Save</button><button>Save a copy</button>
  <p role="status" id="result"></p><script>
  document.querySelector('#save').onclick = () => { document.querySelector('#result').textContent = 'Saved successfully'; };
  </script>`;

function alertCase(id: string, route: string, locator = encodedAlert): CaseInput {
  return {
    id,
    title: 'Show the duplicate warning',
    classification: 'OQ',
    requirements: ['R-1'],
    steps: [
      {
        id: '01',
        instruction: 'Check the duplicate warning.',
        actions: [{ op: 'navigate', url: route }],
        assertions: [
          {
            id: `A-${id}`,
            locator,
            read: 'text',
            comparison: 'contains',
            expected: expectedDuplicate,
          },
        ],
      },
    ],
  };
}

function visibleAlertStep(
  id: string,
  route: string,
  assertionId: string,
  locator: LocatorSpec,
  expected = true,
) {
  return {
    id,
    instruction: 'Check the validation message.',
    actions: [{ op: 'navigate', url: route }],
    assertions: [{ id: assertionId, locator, read: 'visible', comparison: 'equals', expected }],
  } satisfies CaseInput['steps'][number];
}

async function withBrowserFixture(
  pages: Record<string, string | ((visits: number) => string)>,
  run: (fixture: { root: string; url: string; visits: Record<string, number> }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'provenarium-guided-dry-run-'));
  const visits: Record<string, number> = {};
  const server = createServer((request, response) => {
    const route = new URL(request.url!, 'http://localhost').pathname;
    const page = pages[route];
    if (page === undefined) {
      response.writeHead(404).end();
      return;
    }
    visits[route] = (visits[route] ?? 0) + 1;
    response.setHeader('content-type', 'text/html');
    response.end(
      `<!doctype html><title>Records</title>${typeof page === 'function' ? page(visits[route]) : page}`,
    );
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test HTTP server did not start.');
    await run({ root, url: `http://127.0.0.1:${address.port}`, visits });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

function testPlan(url: string, cases: CaseInput[]) {
  return planSchema.parse({
    schema_version: 1,
    runtime_version: 1,
    id: 'PLAN',
    title: 'Check a synthetic test register',
    urs_revision: '1',
    target: { url, allowed_origins: [url] },
    environment: { timeout_ms: 1000 },
    obligations: [
      {
        id: 'OB-1',
        requirement_id: 'R-1',
        source: 'R-1/statement',
        statement: 'The register reports the expected operation outcome.',
        assertion_ids: cases.flatMap((testCase) =>
          testCase.steps.flatMap((step) => step.assertions.map((assertion) => assertion.id)),
        ),
      },
    ],
    cases,
  });
}

it('batches proven action and assertion locator repairs in one rerun while retaining app failures', async () => {
  const wrongMessage = 'Saved the duplicate.';
  await withBrowserFixture(
    {
      '/save': saveMarkup,
      '/duplicate': duplicateMarkup(),
      '/wrong-result': duplicateMarkup(wrongMessage),
      '/intermittent': (visits) => duplicateMarkup(visits === 1 ? wrongMessage : expectedDuplicate),
    },
    async ({ root, url, visits }) => {
      const plan = testPlan(url, [
        saveCase,
        alertCase('OQ-DUP', '/duplicate'),
        alertCase('OQ-WRONG', '/wrong-result'),
        alertCase('OQ-INTERMITTENT', '/intermittent', correctAlert),
      ]);
      const original = structuredClone(plan);
      const expected = structuredClone(plan);
      const action = expected.cases[0].steps[0].actions[1];
      if (action.op !== 'click') throw new Error('Expected the save action.');
      action.locator.exact = true;
      expected.cases[1].steps[0].assertions[0].locator = correctAlert;
      expected.cases[2].steps[0].assertions[0].locator = correctAlert;

      const repaired = await checkPlanInBrowser(root, plan, []);

      expect(plan).toEqual(original);
      expect(repaired.plan).toEqual(expected);
      expect(visits).toEqual({
        '/save': 2,
        '/duplicate': 2,
        '/wrong-result': 2,
        '/intermittent': 2,
      });
      expect(repaired.rehearsalBeforeRepair?.cases.map(({ status }) => status)).toEqual([
        'failed',
        'failed',
        'failed',
        'failed',
      ]);
      expect(repaired.rehearsal.cases.map(({ status }) => status)).toEqual([
        'passed',
        'passed',
        'failed',
        'passed',
      ]);
      expect(repaired.rehearsal.plan_sha256).toBe(
        createHash('sha256').update(JSON.stringify(repaired.plan)).digest('hex'),
      );
      expect(repaired.locatorRepairs).toEqual([
        expect.objectContaining({ case_id: 'OQ-SAVE', step_id: '01', action_index: 1 }),
        expect.objectContaining({ case_id: 'OQ-DUP', step_id: '01', assertion_id: 'A-OQ-DUP' }),
        expect.objectContaining({ case_id: 'OQ-WRONG', step_id: '01', assertion_id: 'A-OQ-WRONG' }),
      ]);
      expect(repaired.rehearsal.observations).toContainEqual(
        expect.objectContaining({
          assertion_id: 'A-OQ-WRONG',
          status: 'failed',
          expected: expectedDuplicate,
          actual: wrongMessage,
        }),
      );
      expect(repaired.unreproducedFailures).toEqual([
        expect.objectContaining({
          assertion_id: 'A-OQ-INTERMITTENT',
          expected: expectedDuplicate,
          actual: wrongMessage,
        }),
      ]);
    },
  );
});

it('leaves the plan intact when a locator repair has no unique visible witness', async () => {
  await withBrowserFixture(
    {
      '/missing': '<div id="messages"></div>',
      '/multiple': `<div id="messages"><p role="alert">Other alert</p><p role="alert">${expectedDuplicate}</p></div>`,
      '/hidden': `<div id="messages"><p role="alert" hidden>${expectedDuplicate}</p></div>`,
      '/role': duplicateMarkup(),
      '/accessible-name': `<p role="alert" aria-label="${encodedAlert.value}">Wrong alert text</p>${duplicateMarkup()}`,
    },
    async ({ root, url, visits }) => {
      const plan = testPlan(url, [
        alertCase('OQ-MISSING', '/missing'),
        alertCase('OQ-MULTIPLE', '/multiple'),
        alertCase('OQ-HIDDEN', '/hidden'),
        alertCase('OQ-ROLE', '/role', { ...encodedAlert, role: 'status' }),
        alertCase('OQ-ACCESSIBLE-NAME', '/accessible-name'),
      ]);
      const result = await checkPlanInBrowser(root, plan, []);
      expect(result.plan).toBe(plan);
      expect(result.rehearsalBeforeRepair).toBeUndefined();
      expect(result.rehearsal.cases.every(({ status }) => status === 'failed')).toBe(true);
      expect(visits).toEqual({
        '/missing': 1,
        '/multiple': 1,
        '/hidden': 1,
        '/role': 1,
        '/accessible-name': 1,
      });
      expect(result.rehearsal.observations).toContainEqual(
        expect.objectContaining({
          assertion_id: 'A-OQ-ACCESSIBLE-NAME',
          status: 'failed',
          expected: expectedDuplicate,
          actual: 'Wrong alert text',
        }),
      );
    },
  );
});

it('repairs visible message text across steps in one rerun and preserves a real mismatch', async () => {
  const stockMessage = 'Stock concentration must be positive.';
  const namedStockStatus = {
    ...namedVolumeAlert,
    role: 'status',
    value: stockMessage,
    exact: true,
  } satisfies LocatorSpec;
  const wrongMessage = 'Final volume is outside the allowed range.';
  const wrongResult = alertCase('OQ-WRONG-TEXT', '/wrong-volume', namedVolumeAlert);
  const wrongAssertion = wrongResult.steps[0].assertions[0];
  wrongAssertion.comparison = 'equals';
  wrongAssertion.expected = volumeMessage;
  await withBrowserFixture(
    {
      '/volume': `<p role="alert">${volumeMessage}</p><p role="alert">An unrelated warning.</p>`,
      '/stock': `<p role="status">${stockMessage}</p>`,
      '/wrong-volume': duplicateMarkup(wrongMessage),
      '/unexpected-volume': duplicateMarkup(volumeMessage),
    },
    async ({ root, url, visits }) => {
      const plan = testPlan(url, [
        {
          ...alertCase('OQ-ALERTS', '/volume'),
          steps: [
            visibleAlertStep('01', '/volume', 'A-VOLUME', namedVolumeAlert),
            visibleAlertStep('02', '/stock', 'A-STOCK', namedStockStatus),
          ],
        },
        wrongResult,
        {
          ...alertCase('OQ-UNEXPECTED-ALERT', '/unexpected-volume'),
          steps: [
            visibleAlertStep('01', '/unexpected-volume', 'A-UNEXPECTED', namedVolumeAlert, false),
          ],
        },
      ]);
      const original = structuredClone(plan);
      const expected = structuredClone(plan);
      for (const item of expected.cases) {
        for (const step of item.steps) {
          const assertion = step.assertions[0];
          assertion.locator = { ...assertion.locator!, match: 'text' };
        }
      }

      const result = await checkPlanInBrowser(root, plan, []);

      expect(plan).toEqual(original);
      expect(result.plan).toEqual(expected);
      expect(visits).toEqual({
        '/volume': 2,
        '/stock': 2,
        '/wrong-volume': 2,
        '/unexpected-volume': 2,
      });
      expect(
        result.rehearsalBeforeRepair?.assertion_issues?.map((issue) => issue.assertion_id),
      ).toEqual(['A-VOLUME', 'A-STOCK', 'A-OQ-WRONG-TEXT', 'A-UNEXPECTED']);
      expect(result.locatorRepairs?.map((repair) => repair.assertion_id)).toEqual([
        'A-VOLUME',
        'A-STOCK',
        'A-OQ-WRONG-TEXT',
        'A-UNEXPECTED',
      ]);
      expect(result.rehearsal.cases.map(({ status }) => status)).toEqual([
        'passed',
        'failed',
        'failed',
      ]);
      expect(result.rehearsal.observations).toContainEqual(
        expect.objectContaining({
          assertion_id: 'A-OQ-WRONG-TEXT',
          status: 'failed',
          expected: volumeMessage,
          actual: wrongMessage,
        }),
      );
      expect(result.rehearsal.observations).toContainEqual(
        expect.objectContaining({
          assertion_id: 'A-UNEXPECTED',
          status: 'failed',
          expected: false,
          actual: true,
        }),
      );
    },
  );
});

it('keeps alert names when visible text does not prove a single match', async () => {
  await withBrowserFixture(
    {
      '/multiple-volume': `<p role="alert">${volumeMessage}</p><p role="alert">${volumeMessage}</p>`,
      '/hidden-volume': `<p role="alert" hidden>${volumeMessage}</p>`,
      '/hidden-alert-text': `<p role="alert">Other warning<span hidden>${volumeMessage}</span></p>`,
      '/case-sensitive-volume': duplicateMarkup('Final Volume'),
      '/named-volume': `<p role="alert" aria-label="Final volume">Wrong alert text</p>${duplicateMarkup(volumeMessage)}`,
      '/unrelated-name': `<p role="alert" aria-label="Other alert">${volumeMessage}</p>`,
      '/no-volume': duplicateMarkup('An unrelated alert.'),
    },
    async ({ root, url, visits }) => {
      const wrongName = alertCase('OQ-NAMED-VOLUME', '/named-volume', namedVolumeAlert);
      wrongName.steps[0].assertions[0].expected = volumeMessage;
      const plan = testPlan(url, [
        alertCase('OQ-MULTIPLE-VOLUME', '/multiple-volume', namedVolumeAlert),
        alertCase('OQ-HIDDEN-VOLUME', '/hidden-volume', namedVolumeAlert),
        alertCase('OQ-HIDDEN-TEXT', '/hidden-alert-text', namedVolumeAlert),
        alertCase('OQ-EXACT-VOLUME', '/case-sensitive-volume', {
          ...namedVolumeAlert,
          exact: true,
        }),
        wrongName,
        alertCase('OQ-UNRELATED-NAME', '/unrelated-name', namedVolumeAlert),
        {
          ...alertCase('OQ-ABSENT-VOLUME', '/no-volume'),
          steps: [visibleAlertStep('01', '/no-volume', 'A-ABSENT', namedVolumeAlert, false)],
        },
      ]);

      const result = await checkPlanInBrowser(root, plan, []);

      expect(result.plan).toBe(plan);
      expect(result.locatorRepairs).toBeUndefined();
      expect(result.rehearsalBeforeRepair).toBeUndefined();
      expect(visits).toEqual({
        '/multiple-volume': 1,
        '/hidden-volume': 1,
        '/hidden-alert-text': 1,
        '/case-sensitive-volume': 1,
        '/named-volume': 1,
        '/unrelated-name': 1,
        '/no-volume': 1,
      });
      expect(result.rehearsal.cases.map(({ status }) => status)).toEqual([
        'failed',
        'failed',
        'failed',
        'failed',
        'failed',
        'failed',
        'passed',
      ]);
      expect(result.rehearsal.observations).toContainEqual(
        expect.objectContaining({
          assertion_id: 'A-OQ-NAMED-VOLUME',
          status: 'failed',
          expected: volumeMessage,
          actual: 'Wrong alert text',
        }),
      );
    },
  );
});

it('stops when a provisional alert repair cannot be retained safely', async () => {
  await withBrowserFixture(
    { '/volume': duplicateMarkup(volumeMessage) },
    async ({ root, url, visits }) => {
      const plan = testPlan(url, [
        {
          ...alertCase('OQ-VOLUME', '/volume'),
          steps: [visibleAlertStep('01', '/volume', 'A-VOLUME', namedVolumeAlert, true)],
        },
      ]);
      const result = await checkPlanInBrowser(root, plan, [], {
        synthetic: { password: namedVolumeAlert.value },
      });

      expect(result.plan).toBe(plan);
      expect(result.rehearsal.role_text_probes).toBe(1);
      expect(result.rehearsalWarning).toContain('could not retain enough evidence');
      expect(result.locatorRepairs).toBeUndefined();
      expect(visits).toEqual({ '/volume': 1 });
    },
  );
});
