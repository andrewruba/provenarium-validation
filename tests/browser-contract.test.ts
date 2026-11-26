import { expect, it } from 'vitest';
import { planSchema, ursSchema, type Action, type Assertion } from '../src/schema.js';
import { describeAction, validatePlanStructure } from '../src/compiler.js';

function check(
  actions: Action[],
  assertions: Partial<Assertion>[] = [
    {
      id: 'A1',
      locator: { by: 'text', value: 'record' },
      comparison: 'equals',
      expected: 'record',
    },
  ],
) {
  const urs = ursSchema.parse({
    schema_version: 1,
    document: {
      id: 'URS',
      revision: '1',
      title: 'Browser checks',
      intended_use: 'Test browser state',
    },
    families: [
      {
        id: 'F',
        title: 'State',
        requirements: [
          { id: 'URS-1', title: 'State', statement: 'Retain a record across browser restart.' },
        ],
      },
    ],
  });
  const plan = planSchema.parse({
    schema_version: 1,
    runtime_version: 1,
    id: 'PLAN',
    title: 'Browser protocol',
    urs_revision: '1',
    target: { url: 'https://app.example.test/', allowed_origins: ['https://app.example.test'] },
    environment: {},
    obligations: [
      {
        id: 'OB1',
        requirement_id: 'URS-1',
        source: 'URS-1/statement',
        statement: 'Verify record state.',
        assertion_ids: assertions.map((a) => a.id),
      },
    ],
    cases: [
      {
        id: 'OQ-1',
        title: 'State',
        classification: 'OQ',
        requirements: ['URS-1'],
        steps: [
          {
            id: 'S1',
            instruction: 'Exercise the approved browser procedure.',
            actions,
            assertions,
          },
        ],
      },
    ],
  });
  return validatePlanStructure(plan, urs);
}

it('registers dialog and negative-download outputs for executable assertions', () => {
  expect(
    check(
      [
        {
          op: 'dialog',
          locator: { by: 'text', value: 'Clear' },
          response: 'dismiss',
          as: 'confirmation',
        },
        { op: 'observe_download', locator: { by: 'text', value: 'Download' }, as: 'emptyExport' },
      ],
      [
        { id: 'A1', variable: 'confirmation.count', comparison: 'equals', expected: 1 },
        { id: 'A2', variable: 'emptyExport.count', comparison: 'equals', expected: 0 },
      ],
    ),
  ).toEqual([]);
});

it('checks browser names, isolation, restart, and context resets before approval', () => {
  const actions: Action[] = [
    { op: 'browser', command: 'open_profile', name: 'persist', url: '/' },
    { op: 'browser', command: 'open_tab', name: 'second', url: '/' },
    { op: 'browser', command: 'restart_profile', name: 'persist' },
    { op: 'browser', command: 'select_tab', name: 'main' },
    { op: 'browser', command: 'select_profile', name: 'main' },
  ];
  expect(check(actions)).toEqual([]);
  expect(
    check([...actions, { op: 'browser', command: 'select_tab', name: 'second' }]).join(),
  ).toContain('unknown browser tab');
  expect(check([{ op: 'browser', command: 'restart_profile', name: 'main' }]).join()).toContain(
    'persistent',
  );
  expect(check([{ op: 'browser', command: 'open_tab', name: 'main' }]).join()).toContain('unique');
  expect(check([{ op: 'browser', command: 'select_profile', name: 'missing' }]).join()).toContain(
    'existing',
  );
});

it('rejects new browser navigations outside scope and URL arguments on selection', () => {
  expect(
    check([
      { op: 'browser', command: 'open_profile', name: 'p', url: 'https://outside.example/' },
    ]).join(),
  ).toContain('outside declared origins');
  expect(
    check([{ op: 'browser', command: 'select_tab', name: 'main', url: '/' }]).join(),
  ).toContain('only opening');
});

it('renders the exact new actions for protocol review', () => {
  expect(describeAction({ op: 'browser', command: 'restart_profile', name: 'p' })).toContain(
    'restart profile p',
  );
  expect(describeAction({ op: 'storage', mode: 'denied' })).toContain('denied');
  expect(
    describeAction({
      op: 'observe_download',
      locator: { by: 'text', value: 'Download' },
      as: 'result',
      timeout_ms: 2000,
    }),
  ).toContain('2000');
});
