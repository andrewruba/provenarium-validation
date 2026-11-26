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
import { resolutionProposalSchema } from '../src/urs-resolution.js';
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
    }
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
