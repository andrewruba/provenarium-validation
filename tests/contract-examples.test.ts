import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { protocolContractExamples } from '../src/authoring/contract-examples.js';
import { validatePlanStructure } from '../src/compiler.js';
import {
  actionSchema,
  assertionSchema,
  locatorSchema,
  planSchema,
  ursSchema,
} from '../src/schema.js';

describe('provider protocol contract examples', () => {
  it('combines the examples into a structurally valid plan with declared observation variables', () => {
    const urs = ursSchema.parse({
      schema_version: 1,
      document: {
        id: 'EX-URS',
        revision: '1',
        title: 'Example',
        intended_use: 'Illustrate shapes.',
      },
      families: [
        {
          id: 'example',
          title: 'Example',
          requirements: [
            {
              id: 'EX-REQ',
              title: 'Example behavior',
              statement: 'Display and export example records.',
            },
          ],
        },
      ],
    });
    const plan = planSchema.parse({
      schema_version: 1,
      runtime_version: 1,
      id: 'EX-PLAN',
      title: 'Example protocol',
      urs_revision: '1',
      target: { url: 'https://example.invalid/', allowed_origins: ['https://example.invalid'] },
      environment: {},
      access: [protocolContractExamples.anonymous_access],
      obligations: [
        {
          id: 'EX-OB',
          requirement_id: 'EX-REQ',
          source: 'EX-REQ/statement',
          statement: 'Display and export example records.',
          assertion_ids: protocolContractExamples.automated_step.assertions.map(
            (assertion) => assertion.id,
          ),
        },
      ],
      cases: [
        {
          id: 'EX-CASE',
          title: 'Example behavior',
          classification: 'OQ',
          requirements: ['EX-REQ'],
          actor: 'EX-ACTOR',
          steps: [protocolContractExamples.automated_step],
        },
      ],
    });
    expect(validatePlanStructure(plan, urs)).toEqual([]);
    const malformed = structuredClone(plan);
    malformed.cases[0].steps[0].assertions.find(
      (assertion) => assertion.id === 'EX-WILDCARD',
    )!.expected = '(?:required|missing)';
    expect(validatePlanStructure(malformed, urs)).toEqual([
      expect.stringContaining('EX-WILDCARD: matches supports literal text and the * wildcard'),
    ]);
  });

  it('explains local refinements that the JSON schema alone does not encode', () => {
    const guidance = protocolContractExamples.guidance.join('\n');
    expect(guidance).toContain('exactly one locator or variable');
    expect(guidance).toContain('role and value');
    expect(guidance).toContain('instead of setting them to null');
    expect(locatorSchema.safeParse({ by: 'role', value: 'Save' }).success).toBe(false);
    const assertion = {
      id: 'EX-ASSERT',
      locator: { by: 'label', value: 'Field' },
      comparison: 'equals',
      expected: 'x',
    };
    expect(assertionSchema.safeParse(assertion).success).toBe(true);
    expect(assertionSchema.safeParse({ ...assertion, variable: 'records.1.0' }).success).toBe(
      false,
    );
    expect(assertionSchema.safeParse({ ...assertion, variable: null }).success).toBe(false);
  });

  it('distinguishes observable-state assertions from read-action vocabulary', () => {
    const visible = protocolContractExamples.automated_step.assertions[0];
    expect(assertionSchema.safeParse(visible).success).toBe(true);
    expect(
      actionSchema.safeParse({ op: 'read', locator: visible.locator, read: 'visible', as: 'state' })
        .success,
    ).toBe(false);
    expect(protocolContractExamples.guidance.join('\n')).toContain('do not create a read action');
  });

  it('shows complete CSV expectations, finite literal alternatives, and wildcard semantics', () => {
    const assertions = protocolContractExamples.automated_step.assertions;
    expect(assertions.find((assertion) => assertion.id === 'EX-CSV')).toMatchObject({
      variable: 'export.text',
      comparison: 'csv_equals',
      expected: [['Example header'], ['Example input']],
    });
    expect(assertions.find((assertion) => assertion.id === 'EX-MESSAGE')).toMatchObject({
      locator: { by: 'role', role: 'status', match: 'text', value: 'Example record' },
      comparison: 'contains_any',
      expected: ['Example record saved', 'Example record created'],
    });
    const guidance = protocolContractExamples.guidance.join('\n');
    expect(guidance).toContain('only * is special');
    expect(guidance).toContain('do not write regex for CSV');
    const schema = JSON.stringify(z.toJSONSchema(assertionSchema, { unrepresentable: 'any' }));
    expect(schema).toContain('never regular expressions');
    expect(schema).toContain('Preserve exact cell strings and row order');
  });
});
