import { describe, expect, it } from 'vitest';
import { planSchema, ursSchema, type Plan, type Urs } from '../src/schema.js';
import {
  normalizeObligationSources,
  obligationSourceCatalog,
  validatePlan,
  validatePlanStructure,
} from '../src/compiler.js';

function fixture(): { urs: Urs; plan: Plan } {
  const urs = ursSchema.parse({
    schema_version: 1,
    document: {
      id: 'URS',
      revision: '1',
      title: 'Sample register',
      intended_use: 'Synthetic records',
    },
    families: [
      {
        id: 'records',
        title: 'Records',
        requirements: [
          {
            id: 'URS-1',
            title: 'Save records',
            statement: 'Save a unique sample identifier.',
            details: ['Reject duplicate identifiers.', 'Preserve existing records on rejection.'],
            table: { columns: ['Field', 'Rule'], rows: [['Sample ID', 'Required']] },
            rationale: 'Prevent record loss.',
            references: ['design.md'],
          },
        ],
      },
    ],
  });
  const plan = planSchema.parse({
    schema_version: 1,
    runtime_version: 1,
    id: 'PLAN',
    title: 'Sample qualification',
    urs_revision: '1',
    target: { url: 'https://example.com/', allowed_origins: ['https://example.com'] },
    environment: {},
    access: [
      {
        id: 'visitor',
        role: 'Workspace user',
        state: 'signed_out',
        mode: 'anonymous',
        purpose: 'Use the public app without login.',
        cases: ['OQ-1'],
      },
    ],
    obligations: [
      {
        id: 'OB-1',
        requirement_id: 'URS-1',
        source: 'URS-1/statement',
        statement: 'Save a unique sample identifier.',
        manual_case_ids: ['OQ-1'],
      },
    ],
    cases: [
      {
        id: 'OQ-1',
        title: 'Save a record',
        classification: 'OQ',
        requirements: ['URS-1'],
        actor: 'visitor',
        manual: true,
        manual_procedure: 'Save a synthetic record.',
        manual_expected: 'The record appears once.',
        steps: [],
      },
    ],
  });
  return { urs, plan };
}

describe('authoritative obligation source catalog', () => {
  it('provides exact existing behavior bindings and content without metadata or ambiguous labels', () => {
    const { urs, plan } = fixture();
    urs.families[0].requirements[0].details!.push('', 'A later detail.');
    const catalog = obligationSourceCatalog(urs);
    expect(catalog).toEqual([
      {
        requirement_id: 'URS-1',
        source: 'URS-1/statement',
        content: 'Save a unique sample identifier.',
      },
      {
        requirement_id: 'URS-1',
        source: 'URS-1/details/0',
        content: 'Reject duplicate identifiers.',
      },
      {
        requirement_id: 'URS-1',
        source: 'URS-1/details/1',
        content: 'Preserve existing records on rejection.',
      },
      { requirement_id: 'URS-1', source: 'URS-1/details/3', content: 'A later detail.' },
      {
        requirement_id: 'URS-1',
        source: 'URS-1/table',
        content: { columns: ['Field', 'Rule'], rows: [['Sample ID', 'Required']] },
      },
    ]);
    for (const entry of catalog) {
      plan.obligations[0].source = entry.source;
      expect(validatePlanStructure(plan, urs)).toEqual([]);
    }
  });

  it.each([
    'URS-1/statement',
    'URS-1/details/0',
    'URS-1/table',
    'URS-1/table/rows/0',
    'URS-1/table/rows/0/1',
    '/families/0/requirements/0/statement',
    '/families/0/requirements/0/details/1',
    '/families/0/requirements/0/table/rows/0/1',
  ])('accepts a genuine text or table binding: %s', (source) => {
    const { urs, plan } = fixture();
    plan.obligations[0].source = source;
    expect(validatePlanStructure(plan, urs)).toEqual([]);
  });

  it.each([
    'URS-1/id',
    'URS-1/title',
    'URS-1/rationale',
    'URS-1/references/0',
    'URS-1/applicable',
    '/families/0/requirements/0/id',
    '/families/0/requirements/0',
    'URS-1/details/99',
    'URS-1/table/rows/99',
    'URS-1/table/rows/0/99',
    '/families/0/requirements/1/statement',
  ])('rejects metadata, missing behavior and unrelated bindings: %s', (source) => {
    const { urs, plan } = fixture();
    plan.obligations[0].source = source;
    expect(validatePlanStructure(plan, urs)).toContain(
      'OB-1: source must point to existing text or a table in its requirement.',
    );
  });

  it('does not bind an absolute pointer to another requirement', () => {
    const { urs, plan } = fixture();
    urs.families[0].requirements.push({
      ...urs.families[0].requirements[0],
      id: 'URS-2',
      applicable: false,
    });
    plan.obligations[0].source = '/families/0/requirements/1/statement';
    expect(validatePlanStructure(plan, urs).join('\n')).toContain('OB-1: source must point');
  });
});

describe('deterministic source notation repair', () => {
  it.each([
    ['statement', 'URS-1/statement'],
    ['table', 'URS-1/table'],
    ['details[0]', 'URS-1/details/0'],
    ['details/1', 'URS-1/details/1'],
    ['URS-1/details[0]', 'URS-1/details/0'],
    ['URS-1.details[1]', 'URS-1/details/1'],
    ['table.rows[0][1]', 'URS-1/table/rows/0/1'],
    [' /statement ', 'URS-1/statement'],
  ])('canonicalizes the unambiguous label %s', (before, after) => {
    const { urs, plan } = fixture();
    plan.obligations[0].source = before;
    const expected = structuredClone(plan);
    expected.obligations[0].source = after;
    const normalized = normalizeObligationSources(plan, urs);
    expect(normalized).toEqual({
      plan: expected,
      changes: [{ obligation: 'OB-1', before, after }],
    });
    expect(plan.obligations[0].source).toBe(before);
    expect(validatePlanStructure(normalized.plan, urs)).toEqual([]);
  });

  it('repairs fifteen bindings without changing reviewed cases, mapping IDs, or questions', () => {
    const { urs, plan } = fixture();
    const labels = [
      'table',
      'details[0]',
      'statement',
      'statement',
      'statement',
      'statement',
      'statement',
      'statement',
      'details[0]',
      'details[1]',
      'details[0]',
      'details[1]',
      'table',
      'details[0]',
      'details[0]',
    ];
    plan.obligations = labels.map((source, index) => ({
      ...plan.obligations[0],
      id: `OB-${index + 1}`,
      source,
    }));
    plan.questions = [
      { id: 'Q-POLICY', requirement: 'URS-1', question: 'Should empty exports include headers?' },
    ];
    const normalized = normalizeObligationSources(plan, urs);
    expect(normalized.changes).toHaveLength(15);
    const withoutSources = (value: Plan) => ({
      ...value,
      obligations: value.obligations.map(({ source, ...rest }) => rest),
    });
    expect(withoutSources(normalized.plan)).toEqual(withoutSources(plan));
    expect(validatePlanStructure(normalized.plan, urs)).toEqual([]);
    expect(validatePlan(normalized.plan, urs)).toContain(
      'Q-POLICY: Should empty exports include headers?',
    );
  });

  it.each([
    'duplicate protection clause',
    'details[99]',
    'id',
    'title',
    'URS-2/statement',
    'statement and details[0]',
    'table/rows/99',
  ])('does not guess a meaning for %s', (source) => {
    const { urs, plan } = fixture();
    plan.obligations[0].source = source;
    expect(normalizeObligationSources(plan, urs)).toEqual({ plan, changes: [] });
    expect(validatePlanStructure(plan, urs).join('\n')).toContain('source must point');
  });
});

describe('technical errors versus human decisions', () => {
  it('keeps human questions out of structural diagnostics while preserving approval blockers', () => {
    const { urs, plan } = fixture();
    plan.questions = [
      { id: 'Q-EXPORT', requirement: 'URS-1', question: 'Should an empty CSV contain headers?' },
    ];
    urs.open_questions = [
      {
        id: 'Q-URS',
        requirement: 'URS-1',
        question: 'How long are records retained?',
        answer: null,
      },
    ];
    expect(validatePlanStructure(plan, urs)).toEqual([]);
    expect(validatePlan(plan, urs)).toEqual([
      'Q-EXPORT: Should an empty CSV contain headers?',
      'Resolve URS questions before approval.',
    ]);
  });

  it('accepts the public signed_out/anonymous actor contract', () => {
    const { urs, plan } = fixture();
    expect(validatePlanStructure(plan, urs)).toEqual([]);
    plan.access[0].mode = 'credentials';
    expect(validatePlanStructure(plan, urs)).toContain(
      'visitor: signed-out access must use anonymous mode.',
    );
    plan.access[0].mode = 'session';
    expect(validatePlanStructure(plan, urs)).toContain(
      'visitor: reusable sessions require an active account.',
    );
  });

  it('rejects technical-schema questions disguised as linked requirements', () => {
    const { urs, plan } = fixture();
    plan.questions = [
      {
        id: 'IOQ-Q-04',
        requirement: 'Plan runtime compatibility',
        question: 'What source-reference syntax does runtime version 1 accept?',
      },
    ];
    expect(validatePlanStructure(plan, urs).join('\n')).toContain(
      'Tool/runtime schema problems must be repaired by authoring',
    );
  });

  it('rejects question IDs duplicated across the plan without suppressing their content', () => {
    const { urs, plan } = fixture();
    plan.questions = [{ id: 'OB-1', question: 'Which empty-state text is mandatory?' }];
    expect(validatePlanStructure(plan, urs)).toContain('Duplicate plan ID: OB-1');
    expect(validatePlan(plan, urs)).toContain('OB-1: Which empty-state text is mandatory?');
  });
});
