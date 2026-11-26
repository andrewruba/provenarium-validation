import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Budget,
  BudgetError,
  ProviderClient,
  ProviderError,
  ProviderOutputError,
  type Provider,
} from '../src/authoring/provider.js';
import { actionSchema, assertionSchema } from '../src/schema.js';
import { compileStructuredOutput } from '../src/authoring/structured-output.js';

const now = new Date('2026-11-25T12:00:00Z');
const key = 'provider-key-sentinel';
const answerSchema = z.strictObject({ answer: z.string() });

function completed(provider: Provider, text: string, usage = true): Response {
  return new Response(
    JSON.stringify({
      ...(provider === 'openai'
        ? {
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
          }
        : { stop_reason: 'end_turn', content: [{ type: 'text', text }] }),
      ...(usage ? { usage: { input_tokens: 100, output_tokens: 20 } } : {}),
    }),
  );
}
function documentText(document: unknown): string {
  return JSON.stringify(document);
}
function fixture(
  provider: Provider,
  text: string,
  options: { secrets?: string[]; usage?: boolean } = {},
) {
  const transport = vi.fn(async () => completed(provider, text, options.usage));
  const budget = new Budget(5);
  const client = new ProviderClient({
    provider,
    key,
    budget,
    now,
    fetchImpl: transport,
    secrets: options.secrets,
  });
  return { client, budget, transport };
}
async function invalid<T>(
  client: ProviderClient,
  schema: z.ZodType<T>,
): Promise<ProviderOutputError> {
  const error = await client
    .complete(schema, 'Draft', { note: 'request-only-sentinel' })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ProviderOutputError);
  return error as ProviderOutputError;
}

describe('retained invalid provider output', () => {
  it.each(['openai', 'anthropic'] as const)(
    'retains actionable %s paths and allowed values without returning invalid content',
    async (provider) => {
      const candidate = { plan: { comparison: 'invented', count: 'three' } };
      const schema = z.strictObject({
        plan: z.strictObject({ comparison: z.enum(['equals', 'csv_equals']), count: z.number() }),
      });
      const { client, budget, transport } = fixture(
        provider,
        documentText(compileStructuredOutput(schema, provider).encode(candidate)),
      );
      const error = await invalid(client, schema);
      expect(error.diagnostic).toMatchObject({
        request: 1,
        kind: 'document_schema',
        candidate,
        truncated: false,
      });
      expect(error.diagnostic.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: '/plan/comparison',
            code: 'invalid_value',
            allowed_values: ['equals', 'csv_equals'],
          }),
          expect.objectContaining({
            path: '/plan/count',
            code: 'invalid_type',
            expected: 'number',
          }),
        ]),
      );
      expect(client.diagnostics).toEqual([error.diagnostic]);
      expect(error.message).toContain('/plan/count');
      expect(JSON.stringify(error.diagnostic)).not.toContain('request-only-sentinel');
      expect(transport).toHaveBeenCalledTimes(1);
      expect(budget.snapshot()).toEqual({
        cap: 5,
        calls: 1,
        reserved: 0,
        actual: provider === 'openai' ? 0.0008 : 0.0007,
      });
    },
  );

  it('retains local refinement failures after the native shape has been validated', async () => {
    const schema = z.strictObject({ action: actionSchema, assertion: assertionSchema });
    const candidate = {
      action: { op: 'click', locator: { by: 'role', value: 'Save' } },
      assertion: { id: 'A-1', comparison: 'equals', expected: 'yes' },
    };
    const wire = compileStructuredOutput(schema, 'openai').encode(candidate);
    const { client } = fixture('openai', documentText(wire));
    const error = await invalid(client, schema);
    expect(error.diagnostic.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/action/locator',
          code: 'custom',
          message: 'Role locators require a valid role',
        }),
        expect.objectContaining({
          path: '/assertion',
          code: 'custom',
          message: 'Assertion needs exactly one locator or variable',
        }),
      ]),
    );
  });

  it('flattens union branch failures and escapes JSON pointer segments', async () => {
    const schema = z.strictObject({
      'part/with~escapes': z.array(
        z.union([
          z.strictObject({ result: z.string() }),
          z.strictObject({ result: z.strictObject({ value: z.number() }) }),
        ]),
      ),
    });
    const { client } = fixture(
      'openai',
      documentText({ 'part/with~escapes': [{ result: { value: false } }] }),
    );
    const error = await invalid(client, schema);
    expect(error.diagnostic.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/part~1with~0escapes/0/result', expected: 'string' }),
        expect.objectContaining({
          path: '/part~1with~0escapes/0/result/value',
          expected: 'number',
        }),
      ]),
    );
  });

  it('reports the precise unknown field rather than retaining raw Zod errors', async () => {
    const { client } = fixture(
      'openai',
      documentText({ answer: 'yes', execute: 'untrusted-command' }),
    );
    const error = await invalid(client, answerSchema);
    expect(error.diagnostic.issues).toEqual([
      { path: '/execute', code: 'unrecognized_keys', message: 'Unexpected field; remove it.' },
    ]);
    expect(error.diagnostic.candidate).toEqual({ answer: 'yes', execute: 'untrusted-command' });
    expect(error.message).not.toContain('untrusted-command');
  });

  it.each([
    { text: '{broken', kind: 'document_json', path: '', raw: '{broken' },
    { text: '{"answer":', kind: 'document_json', path: '', raw: '{"answer":' },
    { text: documentText({ answer: 1 }), kind: 'document_schema', path: '/answer', raw: undefined },
  ])('distinguishes $kind from other native-output failures', async ({ text, kind, path, raw }) => {
    const { client } = fixture('anthropic', text);
    const error = await invalid(client, answerSchema);
    expect(error.diagnostic.kind).toBe(kind);
    expect(error.diagnostic.issues[0].path).toBe(path);
    expect(error.diagnostic.raw).toBe(raw);
  });

  it('rejects the former opaque payload wrapper', async () => {
    const { client } = fixture('openai', JSON.stringify({ payload: '{"answer":"yes"}' }));
    const error = await invalid(client, answerSchema);
    expect(error.diagnostic.kind).toBe('document_schema');
    expect(error.diagnostic.issues.some((issue) => issue.path === '/payload')).toBe(true);
  });

  it('redacts known secrets, sensitive nested values, paths, and messages', async () => {
    const applicationSecret = 'APPLICATION"SECRET\\end';
    const candidate = {
      answer: 4,
      [key]: 'safe value',
      note: `${key} ${applicationSecret}`,
      nested: {
        password: 'unrecognized-private-value',
        api_key: ['private-array'],
        access_token: { value: 'private-object' },
        Authorization: 'private-header',
      },
    };
    const { client } = fixture('openai', documentText(candidate), { secrets: [applicationSecret] });
    const error = await invalid(client, answerSchema);
    const retained = JSON.stringify({ diagnostic: error.diagnostic, message: error.message });
    for (const forbidden of [
      key,
      'APPLICATION',
      'unrecognized-private-value',
      'private-array',
      'private-object',
      'private-header',
    ])
      expect(retained).not.toContain(forbidden);
    expect(error.diagnostic.candidate).toMatchObject({
      '[REDACTED]': 'safe value',
      note: '[REDACTED] [REDACTED]',
      nested: {
        password: '[REDACTED]',
        api_key: '[REDACTED]',
        access_token: '[REDACTED]',
        Authorization: '[REDACTED]',
      },
    });
  });

  it.each([
    '{"password":"unknown-private',
    '{"access_token":{"value":"unknown-private"',
    '{"secret":["unknown-private"',
    '{"token":123456789',
  ])('omits the remainder of malformed credential-bearing JSON: %s', async (payload) => {
    const { client } = fixture('openai', payload);
    const error = await invalid(client, answerSchema);
    expect(error.diagnostic.kind).toBe('document_json');
    expect(error.diagnostic.raw).toContain('[REDACTED');
    expect(error.diagnostic.raw).not.toMatch(/unknown-private|123456789/);
  });

  it('redacts arbitrary-map and compound-JSON secret values in retained native candidates', async () => {
    const candidate = {
      answer: 4,
      map: { entries: [{ key: 'password', value: 'map-private' }] },
      graph: {
        paths: ['', '/user', '/user/api_key'],
        kinds: ['object', 'object', 'string'],
        values: [null, null, 'graph-private'],
      },
    };
    const { client } = fixture('openai', documentText(candidate));
    const error = await invalid(client, answerSchema);
    const retained = JSON.stringify(error.diagnostic);
    expect(retained).not.toContain('map-private');
    expect(retained).not.toContain('graph-private');
    expect(retained).toContain('[REDACTED]');
  });
  it.each([
    '{"entries":[{"key":"password","value":"unknown-private',
    '{"paths":["","/api_key"],"kinds":["object","string"],"values":[null,"unknown-private',
  ])('redacts secret-bearing typed data in malformed JSON: %s', async (text) => {
    const { client } = fixture('anthropic', text);
    const error = await invalid(client, answerSchema);
    expect(JSON.stringify(error.diagnostic)).not.toContain('unknown-private');
  });
  it('redacts escaped secrets inside malformed native JSON', async () => {
    const applicationSecret = 'APPLICATION"SECRET\\end';
    const text = documentText({
      note: applicationSecret,
      nested: { password: 'unknown-private' },
    }).slice(0, -1);
    const { client } = fixture('openai', text, { secrets: [applicationSecret] });
    const error = await invalid(client, answerSchema);
    expect(error.diagnostic.kind).toBe('document_json');
    expect(JSON.stringify(error.diagnostic)).not.toMatch(/APPLICATION|unknown-private/);
    expect(error.diagnostic.raw).toContain('[REDACTED');
  });

  it('bounds the complete serialized diagnostic including escaped payload and many issues', async () => {
    const many = Array.from({ length: 100 }, () => false);
    const { client } = fixture('openai', documentText({ answer: '"\\\n'.repeat(40000), many }));
    const error = await invalid(
      client,
      z.strictObject({ answer: z.number(), many: z.array(z.string()) }),
    );
    expect(error.diagnostic.truncated).toBe(true);
    expect(error.diagnostic.issues.length).toBeLessThanOrEqual(40);
    expect(error.diagnostic.candidate).toBeUndefined();
    expect(error.diagnostic.raw).toBeTruthy();
    expect(Buffer.byteLength(JSON.stringify(error.diagnostic))).toBeLessThanOrEqual(64 * 1024);
  });

  it('bounds a malformed raw payload with heavily escaped text', async () => {
    const { client } = fixture('anthropic', '"\\\n'.repeat(100000));
    const error = await invalid(client, answerSchema);
    expect(error.diagnostic.kind).toBe('document_json');
    expect(error.diagnostic.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(error.diagnostic))).toBeLessThanOrEqual(64 * 1024);
  });

  it('retains full uncertain reservations for completed malformed output without usage', async () => {
    const { client, budget, transport } = fixture('openai', documentText({ answer: false }), {
      usage: false,
    });
    await invalid(client, answerSchema);
    const first = budget.snapshot();
    await invalid(client, answerSchema);
    expect(client.diagnostics.map((d) => d.request)).toEqual([1, 2]);
    expect(budget.snapshot()).toMatchObject({ actual: 0, calls: 2, reserved: 2 * first.reserved });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('does not retain an exception thrown during local refinement', async () => {
    const { client } = fixture('openai', documentText({ answer: 'yes' }));
    const schema = answerSchema.refine(() => {
      throw new Error('unknown-private');
    });
    const error = await invalid(client, schema);
    expect(error.diagnostic.issues[0]).toMatchObject({ path: '', code: 'custom' });
    expect(JSON.stringify(error.diagnostic)).not.toContain('unknown-private');
  });

  it('returns valid typed output without retaining unnecessary document copies', async () => {
    const { client } = fixture('openai', documentText({ answer: 'yes' }));
    expect(await client.complete(answerSchema, 'Draft', {})).toEqual({ answer: 'yes' });
    expect(client.diagnostics).toEqual([]);
  });
});

describe('retained local validation failures', () => {
  it.each(['document_structure', 'protected_expectation', 'draft_assertion_repair'] as const)(
    'retains %s with precise field paths without dispatching or throwing',
    async (kind) => {
      const { client, budget, transport } = fixture('openai', documentText({ answer: 'yes' }));
      await client.complete(answerSchema, 'Draft', {});
      const spend = budget.snapshot();
      const candidate = {
        changes: [
          {
            assertion: 'CSV-01',
            before: { expected: 'invalid pattern' },
            proposed: { expected: [['ID'], ['A']] },
          },
        ],
        candidate: { title: 'Retained protocol' },
      };
      const diagnostic = client.recordValidationFailure(kind, 'technical correction', candidate, [
        {
          path: ['plan', 'cases', 0, 'part/with~escapes', 'expected'],
          code: 'expected_result_changed',
          message: 'CSV-01 changed an existing expected result.',
        },
      ]);

      expect(diagnostic).toEqual({
        request: 1,
        kind,
        operation: 'technical correction',
        candidate,
        issues: [
          {
            path: '/plan/cases/0/part~1with~0escapes/expected',
            code: 'expected_result_changed',
            message: 'CSV-01 changed an existing expected result.',
          },
        ],
        truncated: false,
      });
      expect(client.diagnostics).toEqual([diagnostic]);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(budget.snapshot()).toEqual(spend);
    },
  );

  it('redacts technical failure labels, codes, paths, messages, and before/proposed values', () => {
    const applicationSecret = 'APPLICATION"SECRET\\end';
    const { client, transport } = fixture('anthropic', '', { secrets: [applicationSecret] });
    const diagnostic = client.recordValidationFailure(
      'protected_expectation',
      `correction ${key}`,
      {
        changes: [{ assertion: 'A-1', before: key, proposed: applicationSecret }],
        candidate: { password: 'unknown-private', title: 'Safe title' },
      },
      [{ path: ['plan', key], code: `changed_${key}`, message: `Rejected ${applicationSecret}` }],
    );

    const retained = JSON.stringify(diagnostic);
    expect(retained).not.toMatch(/provider-key-sentinel|APPLICATION|unknown-private/);
    expect(diagnostic).toMatchObject({
      operation: 'correction [REDACTED]',
      candidate: {
        changes: [{ assertion: 'A-1', before: '[REDACTED]', proposed: '[REDACTED]' }],
        candidate: { password: '[REDACTED]', title: 'Safe title' },
      },
      issues: [
        { path: '/plan/[REDACTED]', code: 'changed_[REDACTED]', message: 'Rejected [REDACTED]' },
      ],
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('bounds the entire technical diagnostic including all metadata and escaped snapshots', () => {
    const { client } = fixture('openai', '');
    const diagnostic = client.recordValidationFailure(
      'document_structure',
      '"\\\n'.repeat(2000),
      { changes: [{ before: '"\\\n'.repeat(50000), proposed: 'replacement' }] },
      Array.from({ length: 100 }, (_, index) => ({
        path: ['plan', '"\\\n'.repeat(500), index],
        code: '"\\\n'.repeat(500),
        message: '"\\\n'.repeat(500),
      })),
    );

    expect(diagnostic.truncated).toBe(true);
    expect(diagnostic.issues.length).toBeLessThanOrEqual(40);
    expect(diagnostic.raw).toBeTruthy();
    expect(Buffer.byteLength(JSON.stringify(diagnostic))).toBeLessThanOrEqual(64 * 1024);
  });
});

describe('nonrepairable provider failures', () => {
  it.each([
    { provider: 'openai' as const, body: { status: 'incomplete', output: [] } },
    {
      provider: 'openai' as const,
      body: { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] },
    },
    { provider: 'anthropic' as const, body: { stop_reason: 'refusal', content: [] } },
    {
      provider: 'anthropic' as const,
      body: { stop_reason: 'end_turn', content: [{ type: 'refusal' }] },
    },
    { provider: 'anthropic' as const, body: { stop_reason: 'max_tokens', content: [] } },
  ])(
    'does not turn $provider incomplete/refused output into a repairable diagnostic',
    async ({ provider, body }) => {
      const transport = vi.fn(async () => new Response(JSON.stringify(body)));
      const budget = new Budget(5);
      const client = new ProviderClient({ provider, key, budget, now, fetchImpl: transport });
      const error = await client.complete(answerSchema, 'Draft', {}).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).not.toBeInstanceOf(ProviderOutputError);
      expect(client.diagnostics).toEqual([]);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(budget.snapshot().reserved).toBeGreaterThan(0);
    },
  );

  it.each(['network', 'unreadable', 'http', 'over-budget'] as const)(
    'does not retry or retain raw %s failure data',
    async (mode) => {
      const transport = vi.fn(async () => {
        if (mode === 'network') throw new Error('unknown-private');
        if (mode === 'unreadable') return new Response('unknown-private');
        if (mode === 'http') return new Response('unknown-private', { status: 503 });
        return new Response(
          JSON.stringify({
            status: 'completed',
            usage: { input_tokens: 300000, output_tokens: 20 },
          }),
        );
      });
      const budget = new Budget(5);
      const client = new ProviderClient({
        provider: 'openai',
        key,
        budget,
        now,
        fetchImpl: transport,
      });
      const error = await client.complete(answerSchema, 'Draft', {}).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(mode === 'over-budget' ? BudgetError : ProviderError);
      expect(error).not.toBeInstanceOf(ProviderOutputError);
      expect(String(error)).not.toContain('unknown-private');
      if (mode === 'http') {
        expect(client.diagnostics).toHaveLength(1);
        expect(client.diagnostics[0]).toMatchObject({
          kind: 'provider_http',
          candidate: { status: 503, error: {} },
        });
        expect(client.diagnostics[0]).not.toHaveProperty('raw');
        expect(JSON.stringify(client.diagnostics)).not.toContain('unknown-private');
      } else expect(client.diagnostics).toEqual([]);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(budget.snapshot()).toMatchObject({ actual: 0, calls: 1 });
      expect(budget.snapshot().reserved).toBeGreaterThan(0);
    },
  );
});
