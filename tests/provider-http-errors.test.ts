import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Budget,
  DEFAULT_MODELS,
  ProviderClient,
  ProviderError,
  ProviderOutputError,
  type Provider,
} from '../src/authoring/provider.js';

const now = new Date('2026-11-26T12:00:00Z');
const schema = z.strictObject({ answer: z.string() });
const key = 'provider-key-sentinel';

function fixture(
  provider: Provider,
  body: string,
  options: {
    status?: number;
    headers?: HeadersInit;
    key?: string;
    secrets?: string[];
  } = {},
) {
  const transport = vi.fn(
    async () => new Response(body, { status: options.status ?? 400, headers: options.headers }),
  );
  const budget = new Budget(5);
  const client = new ProviderClient({
    provider,
    key: options.key ?? key,
    secrets: options.secrets,
    budget,
    now,
    fetchImpl: transport,
  });
  return { client, budget, transport };
}

async function rejected(client: ProviderClient): Promise<ProviderError> {
  const error = await client
    .complete(schema, 'Draft requirements', { note: 'private-request-context-sentinel' })
    .catch((value: unknown) => value);
  expect(error).toBeInstanceOf(ProviderError);
  // HTTP failures must not enter the generated-document repair/retry loop.
  expect(error).not.toBeInstanceOf(ProviderOutputError);
  return error as ProviderError;
}

describe('retained provider HTTP errors', () => {
  it('reports the OpenAI schema rejection with its field, code, and request ID', async () => {
    const apiError = {
      type: 'invalid_request_error',
      code: 'invalid_json_schema',
      param: 'text.format.schema',
      message: "Invalid schema for response_format: 'additionalProperties' must be false.",
    };
    const { client, budget, transport } = fixture('openai', JSON.stringify({ error: apiError }), {
      headers: { 'x-request-id': 'req_openai_400' },
    });
    const error = await rejected(client);
    for (const detail of [
      'HTTP 400',
      apiError.message,
      apiError.type,
      apiError.code,
      apiError.param,
    ])
      expect(error.message).toContain(detail);
    expect(client.diagnostics).toHaveLength(1);
    expect(client.diagnostics[0]).toMatchObject({
      request: 1,
      kind: 'provider_http',
      candidate: {
        provider: 'openai',
        model: DEFAULT_MODELS.openai,
        status: 400,
        request_id: 'req_openai_400',
        error: apiError,
      },
    });
    expect(JSON.stringify(client.diagnostics)).not.toContain('private-request-context-sentinel');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(budget.snapshot()).toMatchObject({ actual: 0, calls: 1 });
    expect(budget.snapshot().reserved).toBeGreaterThan(0);
  });

  it('retains the Anthropic invalid-request envelope and request-id header', async () => {
    const apiError = {
      type: 'invalid_request_error',
      message: 'output_config.format.schema: too many optional parameters',
    };
    const { client, transport } = fixture(
      'anthropic',
      JSON.stringify({ type: 'error', error: apiError }),
      { headers: { 'request-id': 'req_anthropic_400' } },
    );
    const error = await rejected(client);
    expect(error.message).toContain('HTTP 400');
    expect(error.message).toContain(apiError.message);
    expect(client.diagnostics[0]).toMatchObject({
      kind: 'provider_http',
      candidate: {
        provider: 'anthropic',
        model: DEFAULT_MODELS.anthropic,
        status: 400,
        request_id: 'req_anthropic_400',
        error: apiError,
      },
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('redacts known, escaped, and named credentials and drops unrecognized error fields', async () => {
    const quotedKey = 'provider"key-sentinel';
    const applicationSecret = 'application"secret-sentinel';
    const reflected = [
      quotedKey,
      JSON.stringify(quotedKey).slice(1, -1),
      applicationSecret,
      JSON.stringify(applicationSecret).slice(1, -1),
      'password=unlisted-password-secret',
      'authorization: Bearer unlisted-bearer-secret',
    ].join('; ');
    const { client } = fixture(
      'openai',
      JSON.stringify({
        error: {
          type: 'authentication_error',
          message: `Invalid credential: ${reflected}`,
          password: 'unrecognized-field-secret',
          request: { context: 'unrecognized-context-secret' },
        },
        request: 'unrecognized-top-level-secret',
      }),
      { status: 401, key: quotedKey, secrets: [applicationSecret] },
    );
    const error = await rejected(client);
    const retained = error.message + JSON.stringify(client.diagnostics);
    for (const secret of [
      'key-sentinel',
      'secret-sentinel',
      'unlisted-password-secret',
      'unlisted-bearer-secret',
      'unrecognized-field-secret',
      'unrecognized-context-secret',
      'unrecognized-top-level-secret',
    ])
      expect(retained).not.toContain(secret);
    expect(retained).toContain('[REDACTED]');
    expect(error.message).toContain('HTTP 401');
    expect(client.diagnostics[0]).not.toHaveProperty('raw');
  });

  it.each([
    ['HTML', '<html><body>private-error-body-sentinel</body></html>'],
    ['malformed JSON', '{"error":{"message":"private-error-body-sentinel'],
    ['unrecognized JSON', JSON.stringify({ detail: 'private-error-body-sentinel' })],
    [
      'invalid error fields',
      JSON.stringify({
        error: {
          message: { password: 'private-error-body-sentinel' },
          code: ['private-error-body-sentinel'],
        },
      }),
    ],
    [
      'oversized body',
      JSON.stringify({
        error: { message: 'private-error-body-sentinel' + 'x'.repeat(3 * 1024 * 1024) },
      }),
    ],
  ])('retains only metadata for %s without exposing the body', async (_label, body) => {
    const { client, transport } = fixture('openai', body, {
      headers: { 'x-request-id': 'req_unknown_body' },
    });
    const error = await rejected(client);
    expect(error.message).toContain('HTTP 400');
    expect(client.diagnostics[0]).toMatchObject({
      kind: 'provider_http',
      candidate: { provider: 'openai', status: 400, request_id: 'req_unknown_body' },
    });
    expect(client.diagnostics[0]).not.toHaveProperty('raw');
    expect(error.message + JSON.stringify(client.diagnostics)).not.toContain(
      'private-error-body-sentinel',
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('bounds diagnostic fields and sanitizes the request ID', async () => {
    const { client } = fixture(
      'openai',
      JSON.stringify({
        error: {
          type: 'invalid_request_error',
          message: 'Invalid schema: ' + 'x'.repeat(20000),
          param: 'text.format.schema.' + 'p'.repeat(10000),
          code: 'invalid_schema_' + 'c'.repeat(10000),
        },
      }),
      { headers: { 'x-request-id': key + 'r'.repeat(10000) } },
    );
    const error = await rejected(client);
    const serialized = JSON.stringify(client.diagnostics[0]);
    expect(Buffer.byteLength(serialized)).toBeLessThan(64 * 1024);
    expect(error.message.length).toBeLessThan(4000);
    expect(error.message).toContain('Further details are retained in the authoring record.');
    expect(serialized + error.message).not.toContain(key);
    expect(serialized).not.toContain('r'.repeat(1000));
    expect(client.diagnostics[0].truncated).toBe(true);
  });

  it('strips terminal control characters from printed and retained provider details', async () => {
    const { client } = fixture(
      'openai',
      JSON.stringify({
        error: {
          type: 'invalid_request_error',
          message: '\u001b[31mInvalid schema\u0000\u001b[0m',
        },
      }),
    );
    const error = await rejected(client);
    expect(error.message).toContain('Invalid schema');
    expect(error.message).not.toMatch(/[\u0000\u001b]/u);
    const candidate = client.diagnostics[0].candidate as { error: { message: string } };
    expect(candidate.error.message).not.toMatch(/[\u0000\u001b]/u);
  });

  it.each([429, 500, 503])('does not retry HTTP %i or reclaim uncertain budget', async (status) => {
    const { client, budget, transport } = fixture(
      'openai',
      JSON.stringify({ error: { type: 'api_error', message: 'Request could not be completed.' } }),
      { status },
    );
    const error = await rejected(client);
    expect(error.message).toContain(`HTTP ${status}`);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(budget.snapshot()).toMatchObject({ actual: 0, calls: 1 });
    expect(budget.snapshot().reserved).toBeGreaterThan(0);
  });
});
