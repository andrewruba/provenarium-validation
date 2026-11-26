import { describe, expect, it } from 'vitest';
import { auditAutomation, automationCapabilities } from '../src/authoring/automation-policy.js';
import { planSchema, ursSchema } from '../src/schema.js';

const urs = ursSchema.parse({
  schema_version: 1,
  document: { id: 'URS', revision: '1', title: 'Assay', intended_use: 'Review assay results.' },
  families: [
    {
      id: 'assay',
      title: 'Assay',
      requirements: [
        {
          id: 'URS-1',
          title: 'Independent reference',
          statement:
            'Compare against the certified reference assay supplied by an accredited laboratory.',
          details: [
            'A human must perform the physical sample inspection.',
            'Retain browser restart results and CSV filename and byte inspection evidence.',
          ],
        },
      ],
    },
  ],
});
function plan() {
  return planSchema.parse({
    schema_version: 1,
    runtime_version: 1,
    id: 'IOQ',
    title: 'Assay qualification',
    urs_revision: '1',
    target: { url: 'https://example.test', allowed_origins: ['https://example.test'] },
    environment: {},
    obligations: [],
    cases: [
      {
        id: 'OQ-1',
        title: 'Reference assay',
        classification: 'OQ',
        requirements: ['URS-1'],
        manual: true,
        manual_procedure: 'Compare the certificate to the displayed result.',
        manual_expected: 'They agree.',
        steps: [],
      },
    ],
  });
}
const reason = {
  kind: 'external_dependency' as const,
  requirement_id: 'URS-1',
  source: 'URS-1/statement',
  supporting_quote:
    'Compare against the certified reference assay supplied by an accredited laboratory.',
  dependency: 'certified reference assay',
  explanation: 'The required scientific reference comes from the accredited laboratory.',
};

describe('automation policy', () => {
  it('rejects every manual case by default even if it has a grounded exception', () => {
    const value = plan();
    value.cases[0].manual_reason = reason;
    expect(auditAutomation(value, urs)).toEqual([
      expect.stringContaining('OQ-1: manual execution is not enabled'),
    ]);
  });
  it('requires structured grounds when manual work is explicitly allowed', () => {
    expect(auditAutomation(plan(), urs, { allowManual: true })).toEqual([
      expect.stringContaining('structured manual_reason'),
    ]);
  });
  it('allows genuinely external scientific evidence grounded in the requirement', () => {
    const value = plan();
    value.cases[0].manual_reason = reason;
    expect(auditAutomation(value, urs, { allowManual: true })).toEqual([]);
  });
  it('allows a quoted explicit human activity with user permission', () => {
    const value = plan();
    value.cases[0].manual_reason = {
      ...reason,
      kind: 'explicit_manual_requirement',
      source: 'URS-1/details/0',
      supporting_quote: 'A human must perform the physical sample inspection.',
      dependency: 'physical sample inspection',
    };
    expect(auditAutomation(value, urs, { allowManual: true })).toEqual([]);
  });
  it.each([
    'Manual inspection of the physical sample is required.',
    'The physical sample inspection must be performed manually.',
    'Manually inspect the physical sample.',
  ])('accepts an explicit manual instruction: %s', (supporting_quote) => {
    const value = plan();
    const manualUrs = structuredClone(urs);
    manualUrs.families[0].requirements[0].statement = supporting_quote;
    value.cases[0].manual_reason = {
      ...reason,
      kind: 'explicit_manual_requirement',
      supporting_quote,
      dependency: 'physical sample',
    };
    expect(auditAutomation(value, manualUrs, { allowManual: true })).toEqual([]);
  });
  it('rejects invented source evidence and unnamed dependencies', () => {
    const value = plan();
    value.cases[0].manual_reason = {
      ...reason,
      source: 'URS-2/statement',
      dependency: 'unmentioned product owner',
    };
    expect(auditAutomation(value, urs, { allowManual: true }).join(' ')).toContain(
      'must occur exactly',
    );
    expect(auditAutomation(value, urs, { allowManual: true }).join(' ')).toContain('verbatim');
  });
  it('requires the quoted requirement to belong to the case', () => {
    const value = plan();
    value.cases[0].requirements = ['URS-2'];
    value.cases[0].manual_reason = reason;
    expect(auditAutomation(value, urs, { allowManual: true }).join(' ')).toContain(
      'covered by this case',
    );
  });
  it.each(['browser restart', 'CSV filename and byte inspection'])(
    'does not accept %s as an external dependency',
    (dependency) => {
      const value = plan();
      value.cases[0].manual_reason = {
        ...reason,
        source: 'URS-1/details/1',
        supporting_quote: urs.families[0].requirements[0].details[1],
        dependency,
      };
      expect(auditAutomation(value, urs, { allowManual: true }).join(' ')).toContain(
        'supported browser automation',
      );
    },
  );
  it('does not treat an ordinary requirement as an explicit manual instruction', () => {
    const value = plan();
    value.cases[0].manual_reason = { ...reason, kind: 'explicit_manual_requirement' };
    expect(auditAutomation(value, urs, { allowManual: true }).join(' ')).toContain(
      'explicitly calls for a manual or human activity',
    );
  });
  it.each(['explicit_manual_requirement', 'external_dependency'] as const)(
    'does not classify a human-readable CSV export as %s',
    (kind) => {
      const value = plan();
      const csvUrs = structuredClone(urs);
      const supporting_quote = 'Display a human-readable CSV export.';
      csvUrs.families[0].requirements[0].statement = supporting_quote;
      value.cases[0].manual_reason = {
        ...reason,
        kind,
        supporting_quote,
        dependency: 'CSV export',
      };
      expect(auditAutomation(value, csvUrs, { allowManual: true })).not.toEqual([]);
    },
  );
  it.each([
    'Display the download output',
    'CSV export',
    'CSV export display',
    'download availability',
    'browser',
    'form inputs',
  ])('recognizes %s as supported work rather than a specific external resource', (dependency) => {
    const value = plan();
    const browserUrs = structuredClone(urs);
    const supporting_quote = `${dependency} is required.`;
    browserUrs.families[0].requirements[0].statement = supporting_quote;
    value.cases[0].manual_reason = { ...reason, supporting_quote, dependency };
    expect(auditAutomation(value, browserUrs, { allowManual: true }).join(' ')).toContain(
      'supported browser automation',
    );
  });
  it.each([
    'Consult the user manual.',
    'The person identifier is shown.',
    'Display human readable results.',
    'No manual review is required.',
    'A human must not inspect the records.',
  ])('does not interpret descriptive wording as human test execution: %s', (supporting_quote) => {
    const value = plan();
    const descriptiveUrs = structuredClone(urs);
    descriptiveUrs.families[0].requirements[0].statement = supporting_quote;
    value.cases[0].manual_reason = {
      ...reason,
      kind: 'explicit_manual_requirement',
      supporting_quote,
      dependency: supporting_quote,
    };
    expect(auditAutomation(value, descriptiveUrs, { allowManual: true }).join(' ')).toContain(
      'explicitly calls for a manual or human activity',
    );
  });
  it('allows a specific external CSV reference without mistaking its file format for browser work', () => {
    const value = plan();
    const externalUrs = structuredClone(urs);
    const supporting_quote =
      'Compare the result with the certified CSV assay supplied by the independent laboratory.';
    externalUrs.families[0].requirements[0].statement = supporting_quote;
    value.cases[0].manual_reason = {
      ...reason,
      supporting_quote,
      dependency: 'certified CSV assay supplied by the independent laboratory',
    };
    expect(auditAutomation(value, externalUrs, { allowManual: true })).toEqual([]);
  });
  it('does not add fields when parsing legacy cases', () => {
    expect(plan().cases[0]).not.toHaveProperty('manual_reason');
  });
  it('accepts automated cases and publishes the supported capability catalog', () => {
    const value = plan();
    value.cases[0].manual = false;
    expect(auditAutomation(value, urs)).toEqual([]);
    expect(automationCapabilities.map((capability) => capability.id)).toEqual([
      'forms',
      'tables',
      'downloads',
      'browser_contexts',
      'browser_restart',
      'dialogs',
      'storage_failure',
    ]);
  });
});
