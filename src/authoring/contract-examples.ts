import { accessSchema, stepSchema } from '../schema.js';

/** Examples are parsed by the same local schemas used to accept provider output. */
export const protocolContractExamples = {
  guidance: [
    'These examples demonstrate JSON shape only. Use actual requirement IDs, observed locators, and independently justified expected values from this task; do not copy example labels or values.',
    'Objects are strict: do not add fields. Omit unused optional fields instead of setting them to null. Null is allowed only where the supplied schema explicitly permits it.',
    'An assertion has exactly one locator or variable, never both or neither. A role locator must include both role and value.',
    'A read action supports text, value, count, or table. To check visible, enabled, or checked, use an assertion with a locator and the corresponding read value; do not create a read action for them.',
    'Observation variable names are declared by action.as or download.save_as. Dot paths select fields or array cells afterward: records.1.0, export.text, or response.status. Do not use dots in declared variable names.',
    'Screenshot evidence has kind screenshot; download evidence names the preceding download variable. Evidence items are objects with IDs, not filenames or strings.',
    'Use comparison numeric with a numeric expected value and a nonnegative tolerance. Use string expected values for literal formatting checks such as trailing zeros.',
    'A manual case has manual true, concrete manual_procedure and manual_expected text, and an empty steps array. Keep supported browser operations automated.',
  ],
  automated_step: stepSchema.parse({
    id: 'EX-STEP',
    instruction: 'Illustrate supported input, observation, and download shapes.',
    actions: [
      { op: 'fill', locator: { by: 'label', value: 'Example field' }, value: 'Example input' },
      { op: 'click', locator: { by: 'role', role: 'button', value: 'Example save' } },
      {
        op: 'read',
        locator: { by: 'role', role: 'table', value: 'Example records' },
        read: 'table',
        as: 'records',
      },
      {
        op: 'download',
        locator: { by: 'role', role: 'link', value: 'Example download' },
        save_as: 'export',
      },
    ],
    assertions: [
      {
        id: 'EX-VISIBLE',
        locator: { by: 'role', role: 'table', value: 'Example records' },
        read: 'visible',
        comparison: 'equals',
        expected: true,
      },
      {
        id: 'EX-CELL',
        variable: 'records.1.0',
        comparison: 'equals',
        expected: 'Example input',
      },
      {
        id: 'EX-CSV',
        variable: 'export.text',
        comparison: 'contains',
        expected: 'Example header',
      },
    ],
    evidence: [
      { id: 'EX-OBSERVATION', kind: 'observation', variable: 'records' },
      { id: 'EX-DOWNLOAD', kind: 'download', variable: 'export' },
      { id: 'EX-SCREENSHOT', kind: 'screenshot' },
    ],
  }),
  anonymous_access: accessSchema.parse({
    id: 'EX-ACTOR',
    role: 'Example public user',
    state: 'signed_out',
    mode: 'anonymous',
    purpose: 'Illustrate a public application that requires no login.',
    cases: ['EX-CASE'],
  }),
};
