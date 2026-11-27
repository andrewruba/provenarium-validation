import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Budget, MAX_REQUEST_BYTES, ProviderClient } from '../src/authoring/provider.js';
import { caseRequestView } from '../src/authoring/request-windows.js';
import type { GeneratedPlanDocument } from '../src/authoring/plan-edits.js';
import { planSchema } from '../src/schema.js';
import { providerOutputText } from './provider-fixture.js';

function candidate(): GeneratedPlanDocument {
  return {
    plan: planSchema.parse({
      schema_version: 1,
      runtime_version: 1,
      id: 'PLAN',
      title: 'Qualification',
      urs_revision: '1',
      target: { url: 'https://example.test/', allowed_origins: ['https://example.test'] },
      environment: {},
      fixtures: ['fixtures/derivations.txt'],
      access: [
        {
          id: 'PUBLIC',
          role: 'User',
          state: 'signed_out',
          mode: 'anonymous',
          purpose: 'Use the application.',
          cases: ['C1', 'C2'],
        },
      ],
      obligations: [
        {
          id: 'O1',
          requirement_id: 'R1',
          source: 'R1/statement',
          statement: 'Both cases preserve records.',
          assertion_ids: ['A1', 'A2'],
        },
      ],
      questions: [{ id: 'Q1', question: 'Which external assay is approved?', requirement: 'R1' }],
      cases: [1, 2].map((number) => ({
        id: `C${number}`,
        title: `Case ${number}`,
        classification: 'OQ',
        requirements: ['R1'],
        actor: 'PUBLIC',
        prerequisites: [`Case ${number} prerequisite`],
        steps: [
          {
            id: 'S1',
            instruction: `Complete procedure ${number}`,
            actions: [{ op: 'navigate', url: '/' }],
            assertions: [
              {
                id: `A${number}`,
                locator: { by: 'text', value: `Result ${number}` },
                comparison: 'equals',
                expected: `Independent value ${number}`,
              },
            ],
            evidence: [{ id: `E${number}`, kind: 'observation' }],
          },
        ],
      })),
    }),
    fixtures: [
      { path: 'fixtures/derivations.txt', content: 'Independent derivations remain exact.\r\n' },
    ],
  };
}

describe('exact request sizing', () => {
  it.each(['openai', 'anthropic'] as const)(
    'measures %s wire encoding and redaction without network, diagnostics or budget effects',
    async (provider) => {
      const budget = new Budget(15);
      let dispatchedBytes = 0;
      const transport = vi.fn(async (_url: unknown, options?: RequestInit) => {
        const encoded = String(options?.body);
        dispatchedBytes = Buffer.byteLength(encoded);
        expect(encoded).not.toContain('synthetic-secret');
        const text = providerOutputText(options, { result: 'valid' });
        return new Response(
          JSON.stringify(
            provider === 'openai'
              ? {
                  status: 'completed',
                  usage: { input_tokens: 100, output_tokens: 20 },
                  output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
                }
              : {
                  stop_reason: 'end_turn',
                  usage: { input_tokens: 100, output_tokens: 20 },
                  content: [{ type: 'text', text }],
                },
          ),
        );
      });
      const client = new ProviderClient({
        provider,
        key: 'synthetic-secret',
        budget,
        fetchImpl: transport,
        now: new Date('2026-11-27T12:00:00Z'),
      });
      const schema = z.strictObject({ result: z.enum(['valid']) });
      const input = { source: 'µg "quoted"\r\nline \\ path', private: 'synthetic-secret' };
      const before = structuredClone(input);
      const size = client.requestSize(schema, 'Review complete material.', input);
      expect(client.requestSize(schema, 'Review complete material.', input)).toBe(size);
      expect(size).toBeGreaterThan(Buffer.byteLength(JSON.stringify(input)));
      expect(size).toBeLessThan(MAX_REQUEST_BYTES);
      expect(transport).not.toHaveBeenCalled();
      expect(client.diagnostics).toEqual([]);
      expect(budget.snapshot()).toEqual({ cap: 15, actual: 0, reserved: 0, calls: 0 });
      expect(await client.complete(schema, 'Review complete material.', input)).toEqual({
        result: 'valid',
      });
      expect(dispatchedBytes).toBe(size);
      expect(input).toEqual(before);
    },
  );

  it('allows measuring an oversized request without retaining a failed attempt or reserving spend', () => {
    const budget = new Budget(15);
    const transport = vi.fn();
    const client = new ProviderClient({
      provider: 'openai',
      key: 'synthetic-key',
      budget,
      fetchImpl: transport,
      now: new Date('2026-11-27T12:00:00Z'),
    });
    expect(
      client.requestSize(z.strictObject({ answer: z.string() }), 'Review', {
        candidate: 'x'.repeat(MAX_REQUEST_BYTES),
      }),
    ).toBeGreaterThan(MAX_REQUEST_BYTES);
    expect(client.diagnostics).toEqual([]);
    expect(budget.snapshot()).toEqual({ cap: 15, actual: 0, reserved: 0, calls: 0 });
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('case request windows', () => {
  it('keeps every selected case byte and all global coverage, references and fixtures, with a complete ID inventory', () => {
    const original = candidate();
    const before = structuredClone(original);
    const view = caseRequestView(original, ['C2']);
    expect(view.candidate.plan.cases).toEqual([before.plan.cases[1]]);
    expect({ ...view.candidate.plan, cases: before.plan.cases }).toEqual(before.plan);
    expect(view.candidate.fixtures).toEqual(before.fixtures);
    expect(view.case_inventory).toEqual(
      [1, 2].map((n) => ({
        id: `C${n}`,
        title: `Case ${n}`,
        classification: 'OQ',
        requirements: ['R1'],
        manual: false,
        actor: 'PUBLIC',
        steps: [{ id: 'S1', assertion_ids: [`A${n}`], evidence_ids: [`E${n}`] }],
      })),
    );
    expect(view.request_scope).toMatchObject({ case_ids: ['C2'], omitted_case_bodies: 1 });
    view.candidate.plan.cases[0].steps[0].assertions[0].expected = 'changed';
    view.candidate.plan.obligations[0].assertion_ids.push('INVENTED');
    view.case_inventory[0].requirements.push('OTHER');
    expect(original).toEqual(before);
  });

  it('requires exact unique selected case IDs instead of silently returning empty or repeated windows', () => {
    for (const ids of [[], ['C1', 'C1'], ['MISSING']])
      expect(() => caseRequestView(candidate(), ids)).toThrow();
  });
});
