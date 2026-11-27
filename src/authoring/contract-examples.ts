import { accessSchema, stepSchema } from '../schema.js';

/** Examples are parsed by the same local schemas used to accept provider output. */
export const protocolContractExamples = {
  guidance: [
    'These examples demonstrate JSON shape only. Use actual requirement IDs, observed locators, and independently justified expected values from this task; do not copy example labels or values.',
    'Objects are strict: do not add fields. Omit unused optional fields instead of setting them to null. Null is allowed only where the supplied schema explicitly permits it.',
    'An assertion has exactly one locator or variable, never both or neither. A role locator must include both role and value.',
    'A role locator filters by accessible name unless match: text is set. Use match: text to locate an alert or status by its visible message text.',
    'A read action supports text, value, count, or table. To check visible, enabled, or checked, use an assertion with a locator and the corresponding read value; do not create a read action for them.',
    'Observation variable names are declared by action.as or download.save_as. Dot paths select fields or array cells afterward: records.1.0, export.text, or response.status. Do not use dots in declared variable names.',
    'Screenshot evidence has kind screenshot; download evidence names the preceding download variable. Evidence items are objects with IDs, not filenames or strings.',
    'Use comparison numeric with a numeric expected value and a nonnegative tolerance. Use string expected values for literal formatting checks such as trailing zeros.',
    'matches is a bounded literal wildcard comparison: only * is special, and the pattern has at most 200 characters. Never send regex groups, alternatives, flags, anchors, or character classes. Use contains_any with 1 to 20 case-sensitive literal strings (each 1 to 200 characters) only when the intended behavior permits those alternatives.',
    'Use csv_equals on a downloaded .text variable with the complete expected string[][], including headers and every row in order. CSV quoting, a leading BOM, and CRLF versus LF line endings are parsed by the runtime; do not write regex for CSV. Preserve exact cell strings, units, and decimal trailing zeros.',
    'For byte-format requirements, download variables expose filename, byte_length, utf8_valid, has_bom, line_endings (crlf, lf, cr, mixed, or none), final_newline, and unchanged UTF-8 text for bounded valid text downloads. csv_equals alone does not establish encoding, filename, or line endings; assert those fields explicitly.',
    'browser commands open_tab/select_tab share the current profile; open_profile creates an isolated disposable persistent profile, select_profile changes it, and restart_profile actually closes and relaunches its browser process with the same disk profile. The initial profile and tab are named main. Only open_tab/open_profile accept url; restart_profile requires a named profile previously opened with open_profile. No saved actor session is imported into new profiles. Use at most four profiles and eight tabs per profile.',
    'dialog clicks its locator and explicitly accepts or dismisses dialogs, returning count, type, message, and dialogs. response none dismisses unexpected dialogs and still returns their count; assert count equals 0 to establish absence. For expected dialogs, assert count, type, and message, then separately assert the resulting application state.',
    'observe_download observes its locator for timeout_ms (100 to 10000 ms; default 1000), clicks if enabled, and returns count, activated, filenames, and downloads. Assert count equals 0 for no-download requirements. Unexpected downloads are retained as evidence and must fail that expectation. A disabled visible control returns activated false. dialog uses the same bounded observation window.',
    'storage mode denied installs controlled localStorage/sessionStorage denial on the active tab and reloads it before application scripts run. mode normal removes that control and reloads, preserving existing stored data. This tests controlled storage unavailability, not an actual OS quota or browser security setting. No arbitrary generated JavaScript is supported.',
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
        comparison: 'csv_equals',
        expected: [['Example header'], ['Example input']],
      },
      {
        id: 'EX-MESSAGE',
        locator: {
          by: 'role',
          role: 'status',
          value: 'Example record',
          match: 'text',
          exact: false,
        },
        comparison: 'contains_any',
        expected: ['Example record saved', 'Example record created'],
      },
      {
        id: 'EX-WILDCARD',
        variable: 'records.1.0',
        comparison: 'matches',
        expected: 'Example *',
      },
    ],
    evidence: [
      { id: 'EX-OBSERVATION', kind: 'observation', variable: 'records' },
      { id: 'EX-DOWNLOAD', kind: 'download', variable: 'export' },
      { id: 'EX-SCREENSHOT', kind: 'screenshot' },
    ],
  }),
  browser_step: stepSchema.parse({
    id: 'EX-BROWSER-STEP',
    instruction:
      'Illustrate isolated profiles, real restart, dialogs, and bounded download observation.',
    actions: [
      { op: 'browser', command: 'open_profile', name: 'example-profile', url: '/' },
      { op: 'browser', command: 'open_tab', name: 'second-tab', url: '/' },
      { op: 'browser', command: 'select_tab', name: 'main' },
      { op: 'browser', command: 'restart_profile', name: 'example-profile' },
      {
        op: 'dialog',
        locator: { by: 'role', role: 'button', value: 'Example clear' },
        response: 'dismiss',
        as: 'confirmation',
        timeout_ms: 1000,
      },
      {
        op: 'observe_download',
        locator: { by: 'role', role: 'button', value: 'Example empty export' },
        as: 'emptyExport',
        timeout_ms: 1000,
      },
      { op: 'storage', mode: 'denied' },
      { op: 'storage', mode: 'normal' },
    ],
    assertions: [
      { id: 'EX-DIALOG-COUNT', variable: 'confirmation.count', comparison: 'equals', expected: 1 },
      {
        id: 'EX-DIALOG-TYPE',
        variable: 'confirmation.type',
        comparison: 'equals',
        expected: 'confirm',
      },
      {
        id: 'EX-DIALOG-MESSAGE',
        variable: 'confirmation.message',
        comparison: 'equals',
        expected: 'Example: clear all records?',
      },
      { id: 'EX-NO-DOWNLOAD', variable: 'emptyExport.count', comparison: 'equals', expected: 0 },
    ],
    evidence: [{ id: 'EX-BROWSER-OBSERVATION', kind: 'observation', variable: 'confirmation' }],
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
