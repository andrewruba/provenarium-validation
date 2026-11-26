import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import {
  compileStructuredOutput,
  encodeProviderOutput,
  assertProviderSchemaLimits,
} from '../src/authoring/structured-output.js';
import { planSchema, ursSchema } from '../src/schema.js';
import { discoveryActionSchema } from '../src/authoring/discovery.js';
import { generatedPlanSchema, reviewSchema } from '../src/authoring/index.js';
import {
  planEditsSchema,
  planReviewEditsSchema,
  makePlanEditsSchema,
} from '../src/authoring/plan-edits.js';
import { makeResolutionAuthoringSchema, resolutionProposalSchema } from '../src/urs-resolution.js';
import { ursAnswerSuggestionsSchema } from '../src/urs-answers.js';

const providers = ['openai', 'anthropic'] as const;
const json: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(json),
    z.record(z.string(), json),
  ]),
);
function roundtrip<T>(
  schema: z.ZodType<T>,
  value: unknown,
  provider: (typeof providers)[number] = 'openai',
) {
  const compiled = compileStructuredOutput(schema, provider);
  const encoded = compiled.encode(value);
  const parsed = compiled.wireSchema.parse(encoded);
  return { compiled, encoded, decoded: schema.parse(compiled.decode(parsed)) };
}
function expectBareReferences(schema: Record<string, any>) {
  if (schema.$ref) expect(Object.keys(schema)).toEqual(['$ref']);
  for (const child of Object.values(schema.properties ?? {}))
    expectBareReferences(child as Record<string, any>);
  for (const child of Object.values(schema.$defs ?? {}))
    expectBareReferences(child as Record<string, any>);
  if (schema.items) expectBareReferences(schema.items);
  for (const child of schema.anyOf ?? []) expectBareReferences(child);
}

describe.each(providers)('%s native schema contracts', (provider) => {
  it('compiles every authoring contract to a closed nonrecursive schema within provider limits', () => {
    for (const schema of [
      planSchema,
      ursSchema,
      generatedPlanSchema,
      reviewSchema,
      discoveryActionSchema,
      planEditsSchema,
      planReviewEditsSchema,
      resolutionProposalSchema,
      ursAnswerSuggestionsSchema,
    ]) {
      const native = compileStructuredOutput(schema, provider).schema;
      expect(native.type).toBe('object');
      expect(native.properties).not.toHaveProperty('payload');
      expect(() => assertProviderSchemaLimits(native, provider)).not.toThrow();
      expect(JSON.stringify(native)).not.toContain('"additionalProperties":true');
      expect(JSON.stringify(native)).not.toContain('"oneOf"');
      if (provider === 'openai') expectBareReferences(native);
    }
  });
  it('enforces one exclusive outcome per saved answer for nine-question resolution proposals', () => {
    const urs = ursSchema.parse({
      schema_version: 1,
      document: {
        id: 'URS-DB',
        revision: '1',
        title: 'Dilution Bench',
        intended_use: 'Prepare dilutions.',
      },
      families: [
        {
          id: 'F-INPUT',
          title: 'Inputs',
          requirements: [
            {
              id: 'DB-INPUT-01',
              title: 'Numeric inputs',
              statement: 'Accept the reviewed input values.',
            },
          ],
        },
      ],
      open_questions: Array.from({ length: 9 }, (_, index) => ({
        id: `DB-Q-${String(index + 1).padStart(2, '0')}`,
        requirement: 'DB-INPUT-01',
        question: `Which input decision applies to case ${index + 1}?`,
        answer: index ? 'Use decimal notation.' : 'Use explicit limits.',
      })),
    });
    const schema = makeResolutionAuthoringSchema(urs);
    const value = {
      requirements: [
        { value: urs.families[0].requirements[0], reason: 'Apply the supported decisions.' },
      ],
      questions: Object.fromEntries(
        urs.open_questions.map((question, index) => [
          question.id,
          index
            ? { status: 'resolved', requirement_ids: ['DB-INPUT-01'], document: false }
            : { status: 'clarification', reason: 'Which minimum and maximum values are intended?' },
        ]),
      ),
    };
    const result = roundtrip(schema, value, provider);
    expect(result.decoded).toEqual(value);
    expect(() => assertProviderSchemaLimits(result.compiled.schema, provider)).not.toThrow();
    if (provider === 'openai') expectBareReferences(result.compiled.schema);
    expect(result.compiled.schema.properties.questions.required).toEqual(
      urs.open_questions.map((question) => question.id),
    );
    const mixed = structuredClone(result.encoded) as any;
    mixed.questions['DB-Q-01'] = {
      status: 'clarification',
      reason: 'Supply limits.',
      requirement_ids: ['DB-INPUT-01'],
      document: false,
    };
    expect(result.compiled.wireSchema.safeParse(mixed).success).toBe(false);
    const omitted = structuredClone(result.encoded) as any;
    delete omitted.questions['DB-Q-01'];
    expect(result.compiled.wireSchema.safeParse(omitted).success).toBe(false);
    const invented = structuredClone(result.encoded) as any;
    invented.questions['DB-Q-99'] = { status: 'clarification', reason: 'Invented question.' };
    expect(result.compiled.wireSchema.safeParse(invented).success).toBe(false);
  });
  it('preserves URS reference and citation guidance while normalizing described OpenAI references', () => {
    const urs = ursSchema.parse({
      schema_version: 1,
      document: {
        id: 'URS-EXAMPLE',
        revision: 'Draft 0.1',
        title: 'Example',
        intended_use: 'Calculate a result.',
      },
      families: [
        {
          id: 'F-01',
          title: 'Calculation',
          requirements: [
            {
              id: 'URS-001',
              title: 'Result',
              statement: 'Show the calculated result.',
              references: ['references/spec.txt'],
              citations: [{ source: 'source-1', location: 'line 1' }],
            },
          ],
        },
      ],
    });
    const result = roundtrip(ursSchema, urs, provider);
    expect(result.decoded).toEqual(urs);
    const requirement =
      result.compiled.schema.properties.families.items.properties.requirements.items;
    for (const [field, guidance] of [
      ['references', 'Normative input files'],
      ['citations', 'Source provenance'],
    ]) {
      const native = requirement.properties[field];
      const valueSchema = provider === 'openai' ? native.anyOf[0] : native;
      expect(valueSchema.description).toContain(guidance);
      if (provider === 'openai') {
        expect(valueSchema.type).toBe('array');
        expect(valueSchema).not.toHaveProperty('$ref');
      } else expect(valueSchema.$ref).toMatch(/^#\/\$defs\//);
    }
    if (provider === 'openai') expectBareReferences(result.compiled.schema);
  });
  it('roundtrips a real complete plan and enforces its actions and comparisons in the native schema', async () => {
    const plan = planSchema.parse(
      JSON.parse(await readFile('examples/sample-validation/plan.json', 'utf8')),
    );
    const result = roundtrip(generatedPlanSchema, { plan, fixtures: [] }, provider);
    expect(result.decoded).toEqual({ plan, fixtures: [] });
    const text = JSON.stringify(result.compiled.schema);
    expect(text).toContain('"op"');
    expect(text).toContain('"comparison"');
    expect(text).toContain('"csv_equals"');
    expect(text).toContain('"obligations"');
    const malformed = structuredClone(result.encoded) as any;
    malformed.plan.cases[0].steps[0].actions[0].op = 'evaluate';
    expect(result.compiled.wireSchema.safeParse(malformed).success).toBe(false);
  });
  it('keeps all authorized review and technical edit modes within limits and roundtrips scoped edits', async () => {
    const plan = planSchema.parse(
      JSON.parse(await readFile('examples/sample-validation/plan.json', 'utf8')),
    );
    plan.questions = [{ id: 'Q-1', question: 'Is the approved explanation accepted?' }];
    const authorizedRequirementChanges = new Set(plan.cases.flatMap((c) => c.requirements));
    for (const mode of ['review', 'technical'] as const) {
      for (const authorized of [undefined, authorizedRequirementChanges]) {
        for (const questionResolutionFeedback of [undefined, 'Q-1: approved explanation']) {
          const schema = makePlanEditsSchema(
            { plan, fixtures: [] },
            { mode, authorizedRequirementChanges: authorized, questionResolutionFeedback },
          );
          const value = {
            edits: questionResolutionFeedback
              ? [
                  {
                    op: 'resolve_question',
                    question_id: 'Q-1',
                    supporting_quote: questionResolutionFeedback,
                    resolution: 'The preparer approved the explanation.',
                  },
                ]
              : [],
          };
          const result = roundtrip(schema, value, provider);
          expect(result.decoded).toEqual(value);
          expect(() => assertProviderSchemaLimits(result.compiled.schema, provider)).not.toThrow();
          if (provider === 'openai') expectBareReferences(result.compiled.schema);
        }
      }
    }
  });
  it('decodes the exact valid union branch without silently losing fields', () => {
    const schema = z.strictObject({
      value: z.union([
        z.strictObject({ a: z.string().optional() }),
        z.strictObject({ b: z.string() }),
      ]),
    });
    const compiled = compileStructuredOutput(schema, provider);
    const wire = compiled.wireSchema.parse({ value: { b: 'retained' } });
    expect(schema.parse(compiled.decode(wire))).toEqual({ value: { b: 'retained' } });
  });
  it('distinguishes omitted, defaulted and intentionally-null fields at nested levels', () => {
    const schema = z.strictObject({
      records: z.array(
        z.strictObject({
          optional: z.string().optional(),
          nullable: z.string().nullable().optional(),
          items: z.array(z.string()).default([]),
        }),
      ),
    });
    expect(
      roundtrip(
        schema,
        { records: [{}, { nullable: null }, { optional: '', nullable: 'value', items: ['x'] }] },
        provider,
      ).decoded,
    ).toEqual({
      records: [
        { items: [] },
        { nullable: null, items: [] },
        { optional: '', nullable: 'value', items: ['x'] },
      ],
    });
  });
  it('does not confuse literal null or marker-looking values with omission', () => {
    const schema = z.strictObject({ value: json.optional() });
    const values = [
      null,
      '__provenarium_omitted',
      { __provenarium_omitted: true },
      { paths: [''], kinds: ['null'], values: [null] },
      [
        ['ID', 'Value'],
        ['A', '1.250'],
      ],
      [{ key: 'nested', value: [true, { x: null }] }],
    ];
    for (const value of values)
      expect(roundtrip(schema, { value }, provider).decoded).toEqual({ value });
    expect(roundtrip(schema, {}, provider).decoded).toEqual({});
  });
  it('preserves native matrices and encodes deeper compounds as typed data without JSON strings', () => {
    const schema = z.strictObject({ matrix: json, object: json });
    const value = {
      matrix: [
        ['ID', 'Value'],
        ['A', '1.250'],
      ],
      object: { 'a/b~c': [true, { count: 2 }], empty: [], nothing: null },
    };
    const result = roundtrip(schema, value, provider);
    expect((result.encoded as any).matrix).toEqual(value.matrix);
    expect((result.encoded as any).object).toMatchObject({
      paths: ['', '/a~1b~0c', '/a~1b~0c/0', '/a~1b~0c/1', '/a~1b~0c/1/count', '/empty', '/nothing'],
    });
    expect(result.decoded).toEqual(value);
  });
  it('roundtrips arbitrary maps and rejects duplicate keys after native validation', () => {
    const schema = z.strictObject({ map: z.record(z.string(), z.number()) });
    const result = roundtrip(schema, { map: { a: 1, b: 2 } }, provider);
    expect(result.decoded).toEqual({ map: { a: 1, b: 2 } });
    const duplicate = {
      map: {
        entries: [
          { key: 'a', value: 1 },
          { key: 'a', value: 2 },
        ],
      },
    };
    const wire = result.compiled.wireSchema.parse(duplicate);
    expect(() => result.compiled.decode(wire)).toThrow(/Duplicate map key/);
  });
  it('uses a typed root union and rejects invented actions', () => {
    const result = roundtrip(discoveryActionSchema, { action: 'finish' }, provider);
    expect(result.encoded).toEqual({ result: { action: 'finish' } });
    expect(result.decoded).toEqual({ action: 'finish' });
    expect(
      result.compiled.wireSchema.safeParse({ result: { action: 'evaluate', code: 'untrusted' } })
        .success,
    ).toBe(false);
  });
  it('retains unsupported provider constraints for local validation without sending invalid keywords', () => {
    const schema = z.strictObject({
      url: z.url(),
      bounded: z.string().min(2).max(4),
      n: z.number().min(1),
    });
    const result = compileStructuredOutput(schema, provider);
    if (provider === 'openai') {
      expect(result.schema.properties.url).not.toHaveProperty('format');
      expect(result.schema.properties.bounded.minLength).toBe(2);
    } else {
      expect(result.schema.properties.bounded).not.toHaveProperty('minLength');
      expect(result.schema.properties.n).not.toHaveProperty('minimum');
      expect(result.schema.properties.bounded.description).toContain('minLength');
    }
    expect(
      schema.safeParse(
        result.decode(
          result.wireSchema.parse({ url: 'https://example.test', bounded: 'abc', n: 2 }),
        ),
      ).success,
    ).toBe(true);
  });
});

it('preserves deliberate invalid fixtures and unknown fields instead of cleaning them away', () => {
  const contract = compileStructuredOutput(
    z.strictObject({ value: z.enum(['allowed']), optional: z.string().optional() }),
    'openai',
  );
  const encoded = encodeProviderOutput(contract.schema, {
    value: 'invented',
    execute: 'untrusted',
  });
  expect(encoded).toMatchObject({ value: 'invented', execute: 'untrusted' });
  expect(contract.wireSchema.safeParse(encoded).success).toBe(false);
});
it('rejects malformed compound values with duplicate paths, missing parents, array holes or mismatched kinds', () => {
  const contract = compileStructuredOutput(z.strictObject({ value: json }), 'openai');
  const malformed = [
    { paths: ['', ''], kinds: ['object', 'object'], values: [null, null] },
    { paths: ['', '/missing/x'], kinds: ['object', 'string'], values: [null, 'x'] },
    { paths: ['', '/1'], kinds: ['array', 'string'], values: [null, 'x'] },
    { paths: [''], kinds: ['number'], values: ['x'] },
    { paths: [''], kinds: ['null'], values: [] },
  ];
  for (const value of malformed) {
    const wire = contract.wireSchema.parse({ value });
    expect(() => contract.decode(wire)).toThrow();
  }
});
it('rejects unconstrained or unsupported schemas before provider dispatch can occur', () => {
  expect(() => compileStructuredOutput(z.strictObject({ value: z.any() }), 'openai')).toThrow(
    /Unconstrained/,
  );
  const recursive: z.ZodType<any> = z.lazy(() => z.strictObject({ child: recursive.optional() }));
  expect(() => compileStructuredOutput(recursive, 'anthropic')).toThrow(/Recursive/);
  let deep: z.ZodType = z.string();
  for (let i = 0; i < 12; i++) deep = z.strictObject({ child: deep });
  expect(() => compileStructuredOutput(deep, 'openai')).toThrow(/nesting/);
});

it('rejects OpenAI reference siblings in the final native contract', () => {
  const native = compileStructuredOutput(ursSchema, 'openai').schema;
  native.properties.document.properties.id.description = 'A field-specific description.';
  expect(() => assertProviderSchemaLimits(native, 'openai')).toThrow(/sibling keywords/);
});

it('enforces Anthropic optional and union ceilings before dispatch', () => {
  const schema = z.strictObject(
    Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p${i}`, z.string().optional()])),
  );
  const contract = compileStructuredOutput(schema, 'anthropic');
  expect(Object.keys(contract.schema.properties).length - contract.schema.required.length).toBe(24);
  expect(() =>
    compileStructuredOutput(
      z.strictObject({ ...schema.shape, extra: z.string().optional() }),
      'anthropic',
    ),
  ).toThrow(/16 union/);
  const raw = {
    type: 'object',
    properties: Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [`p${i}`, { type: 'string' }]),
    ),
    required: [],
    additionalProperties: false,
  };
  expect(() => assertProviderSchemaLimits(raw, 'anthropic')).toThrow(/24 optional/);
});
