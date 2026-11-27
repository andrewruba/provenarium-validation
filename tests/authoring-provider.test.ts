import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Budget,
  BudgetError,
  MODEL_CATALOG,
  PRESETS,
  ProviderClient,
} from '../src/authoring/provider.js';

const now = new Date('2026-11-25T12:00:00Z');
function response(provider: 'openai' | 'anthropic', value: unknown, usage = true) {
  const text = JSON.stringify(value);
  return new Response(
    JSON.stringify(
      provider === 'openai'
        ? {
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
            ...(usage ? { usage: { input_tokens: 100, output_tokens: 20 } } : {}),
          }
        : {
            stop_reason: 'end_turn',
            content: [{ type: 'text', text }],
            ...(usage ? { usage: { input_tokens: 100, output_tokens: 20 } } : {}),
          },
    ),
    { headers: { 'content-type': 'application/json' } },
  );
}
describe('provider transport and budget', () => {
  it.each(['openai', 'anthropic'] as const)(
    'validates %s output locally and never puts its key in the body',
    async (provider) => {
      const transport = vi.fn(async (_url: unknown, options?: RequestInit) => {
        const body = String(options?.body);
        expect(body).not.toContain('provider-key-sentinel');
        const parsed = JSON.parse(body);
        expect(provider === 'openai' ? parsed.store : parsed.output_config.format.type).toBe(
          provider === 'openai' ? false : 'json_schema',
        );
        const native =
          provider === 'openai' ? parsed.text.format.schema : parsed.output_config.format.schema;
        expect(native.properties.answer).toMatchObject({ type: 'string', enum: ['valid'] });
        expect(native.properties).not.toHaveProperty('payload');
        expect(native.additionalProperties).toBe(false);
        expect(parsed.service_tier).toBe(provider === 'openai' ? 'default' : 'standard_only');
        return response(provider, { answer: 'valid' });
      });
      const budget = new Budget(5);
      const client = new ProviderClient({
        provider,
        key: 'provider-key-sentinel',
        budget,
        now,
        fetchImpl: transport as typeof fetch,
      });
      const result = await client.complete(
        z.strictObject({ answer: z.enum(['valid']) }),
        'Reply with the requested document',
        { note: 'provider-key-sentinel' },
      );
      expect(result).toEqual({ answer: 'valid' });
      expect(transport).toHaveBeenCalledTimes(1);
      expect(budget.snapshot()).toEqual({
        cap: 5,
        calls: 1,
        reserved: 0,
        actual: provider === 'openai' ? 0.0008 : 0.0007,
      });
    },
  );
  it.each(['openai', 'anthropic'] as const)(
    'rejects unsupported %s schemas before budget reservation or dispatch',
    async (provider) => {
      const transport = vi.fn();
      const budget = new Budget(5);
      const client = new ProviderClient({ provider, key: 'x', budget, now, fetchImpl: transport });
      await expect(
        client.complete(z.strictObject({ value: z.any() }), 'Draft', {}),
      ).rejects.toThrow(/native structured/);
      expect(transport).not.toHaveBeenCalled();
      expect(budget.snapshot()).toEqual({ cap: 5, calls: 0, actual: 0, reserved: 0 });
    },
  );
  it('rejects an unsupported or stale pricing model before any request', () => {
    expect(
      () =>
        new ProviderClient({
          provider: 'openai',
          model: 'invented',
          key: 'x',
          budget: new Budget(5),
          now,
        }),
    ).toThrow(/Unsupported/);
    expect(
      () =>
        new ProviderClient({
          provider: 'openai',
          model: 'claude-sonnet-5-5',
          key: 'x',
          budget: new Budget(5),
          now,
        }),
    ).toThrow(/Unsupported/);
    expect(
      () =>
        new ProviderClient({
          provider: 'openai',
          key: 'x',
          budget: new Budget(5),
          now: new Date('2027-04-01'),
        }),
    ).toThrow(/expired/);
  });
  it('redacts known application secrets recursively before serializing provider input', async () => {
    const secret = 'APPLICATION"SECRET';
    const transport = vi.fn(async (_url: unknown, options?: RequestInit) => {
      const request = JSON.parse(String(options?.body));
      const input = request.input[0].content[0].text;
      expect(input).not.toContain('APPLICATION');
      expect(input).toContain('[REDACTED]');
      return response('openai', { answer: 'valid' });
    });
    const client = new ProviderClient({
      provider: 'openai',
      key: 'x',
      budget: new Budget(5),
      now,
      secrets: [secret],
      fetchImpl: transport as typeof fetch,
    });
    await client.complete(z.object({ answer: z.string() }), 'Draft', {
      note: `The supplied credential is ${secret}`,
    });
  });
  it('refuses a request before dispatch when its reservation exceeds the cap', async () => {
    const transport = vi.fn();
    const budget = new Budget(0.01);
    const client = new ProviderClient({
      provider: 'openai',
      key: 'x',
      budget,
      now,
      fetchImpl: transport,
    });
    await expect(
      client.complete(z.object({ answer: z.string() }), 'Draft', {}),
    ).rejects.toBeInstanceOf(BudgetError);
    expect(transport).not.toHaveBeenCalled();
    expect(budget.snapshot().calls).toBe(0);
  });
  it('retains uncertain reservations and does not retry failed transport', async () => {
    const transport = vi.fn(async () => {
      throw new Error('provider-key-sentinel raw transport');
    });
    const budget = new Budget(5);
    const client = new ProviderClient({
      provider: 'anthropic',
      key: 'provider-key-sentinel',
      budget,
      now,
      fetchImpl: transport,
    });
    await expect(client.complete(z.object({ answer: z.string() }), 'Draft', {})).rejects.toThrow(
      /reservation is retained/,
    );
    expect(transport).toHaveBeenCalledTimes(1);
    expect(budget.snapshot().reserved).toBeGreaterThan(0);
    expect(budget.snapshot().actual).toBe(0);
  });
  it.each(['openai', 'anthropic'] as const)(
    'rejects extra executable fields from %s output',
    async (provider) => {
      const transport = vi.fn(async () =>
        response(provider, { answer: 'valid', execute: 'rm -rf /' }),
      );
      const client = new ProviderClient({
        provider,
        key: 'x',
        budget: new Budget(5),
        now,
        fetchImpl: transport,
      });
      await expect(
        client.complete(z.strictObject({ answer: z.string() }), 'Draft', {}),
      ).rejects.toThrow(/local schema validation/);
    },
  );
  it('rejects truncated output even when text looks valid', async () => {
    const transport = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: 'incomplete',
            usage: { input_tokens: 100, output_tokens: 24000 },
            output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }],
          }),
        ),
    );
    const budget = new Budget(5);
    const client = new ProviderClient({
      provider: 'openai',
      key: 'x',
      budget,
      now,
      fetchImpl: transport,
    });
    await expect(client.complete(z.object({}), 'Draft', {})).rejects.toThrow(/incomplete/);
    expect(budget.snapshot().actual).toBeGreaterThan(0);
  });
  it('retains reservation when provider omits usage', async () => {
    const clientBudget = new Budget(5);
    const client = new ProviderClient({
      provider: 'anthropic',
      key: 'x',
      budget: clientBudget,
      now,
      fetchImpl: async () => response('anthropic', { answer: 'yes' }, false),
    });
    await client.complete(z.object({ answer: z.string() }), 'Draft', {});
    expect(clientBudget.snapshot().reserved).toBeGreaterThan(0);
  });
  it('keeps the full reservation if reported input crosses the bounded request and long-context threshold', async () => {
    const budget = new Budget(5);
    const transport = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: 'completed',
            usage: { input_tokens: 300000, output_tokens: 20 },
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: JSON.stringify({ answer: 'yes' }) }],
              },
            ],
          }),
        ),
    );
    const client = new ProviderClient({
      provider: 'openai',
      key: 'test-key',
      budget,
      now,
      fetchImpl: transport,
    });
    await expect(client.complete(z.object({ answer: z.string() }), 'Draft', {})).rejects.toThrow(
      /request bounds/,
    );
    expect(budget.snapshot().reserved).toBeGreaterThan(0);
    expect(budget.snapshot().actual).toBe(0);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('settles cache usage at conservative rates without reclaiming an assumed discount', async () => {
    const budget = new Budget(5);
    const transport = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 100,
              cache_creation_input_tokens: 200,
              cache_read_input_tokens: 300,
              output_tokens: 20,
            },
            content: [{ type: 'text', text: JSON.stringify({ answer: 'yes' }) }],
          }),
        ),
    );
    const client = new ProviderClient({
      provider: 'anthropic',
      key: 'test-key',
      budget,
      now,
      fetchImpl: transport,
    });
    await client.complete(z.object({ answer: z.string() }), 'Draft', {});
    expect(budget.snapshot().actual).toBe((600 * 4 + 20 * 15) / 1e6);
    expect(budget.snapshot().reserved).toBe(0);
  });
  it('defines independent cap and review-round defaults', () => {
    expect(PRESETS).toEqual({
      quick: { cap: 5, reviews: 1 },
      standard: { cap: 15, reviews: 2 },
      thorough: { cap: 40, reviews: 3 },
    });
    expect(Object.keys(MODEL_CATALOG)).toHaveLength(2);
  });
});

it.each(['openai', 'anthropic'] as const)(
  '%s identifies an oversized assembled request without dispatch, reservation, or copying its source',
  async (provider) => {
    const transport = vi.fn();
    const budget = new Budget(15);
    const client = new ProviderClient({
      provider,
      key: 'synthetic-private-key',
      budget,
      now,
      fetchImpl: transport,
    });
    await expect(
      client.complete(z.strictObject({ answer: z.string() }), 'Review', {
        candidate: { content: 'Large retained procedure '.repeat(12000) },
        context: { text: 'small source passage' },
      }),
    ).rejects.toThrow(/assembled authoring request.*local 200000-byte limit/);
    expect(transport).not.toHaveBeenCalled();
    expect(budget.snapshot()).toEqual({ cap: 15, calls: 0, reserved: 0, actual: 0 });
    expect(client.diagnostics).toEqual([
      expect.objectContaining({
        kind: 'request_size',
        operation: 'request preparation',
        candidate: expect.objectContaining({
          request_bytes: expect.any(Number),
          limit_bytes: 200000,
          input_field_json_bytes: expect.objectContaining({
            candidate: expect.any(Number),
            context: expect.any(Number),
          }),
        }),
      }),
    ]);
    expect(JSON.stringify(client.diagnostics)).not.toContain('Large retained procedure');
    expect(JSON.stringify(client.diagnostics)).not.toContain('synthetic-private-key');
  },
);
