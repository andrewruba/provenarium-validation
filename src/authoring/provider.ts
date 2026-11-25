import { z } from 'zod';
import { boundedResponse, redactValue } from './security.js';

export type Provider = 'openai' | 'anthropic';
export type Thoroughness = 'quick' | 'standard' | 'thorough';
export const PRESETS = {
  quick: { cap: 5, reviews: 1 },
  standard: { cap: 15, reviews: 2 },
  thorough: { cap: 40, reviews: 3 },
} as const;
export const DEFAULT_MODELS: Record<Provider, string> = {
  openai: 'gpt-6.2-sol',
  anthropic: 'claude-sonnet-5-5',
};

/** Rates verified from the official model pages on 2026-11-25. No hosted tools,
 * explicit caching, fast tiers, image inputs, or batch calls are enabled. */
export const MODEL_CATALOG = {
  'gpt-6.2-sol': {
    provider: 'openai',
    input: 2,
    output: 10,
    reserveInput: 5,
    reserveOutput: 15,
    source: 'https://developers.openai.com/api/docs/models/gpt-6.2-sol',
    validUntil: '2027-02-23',
  },
  'claude-sonnet-5-5': {
    provider: 'anthropic',
    input: 2,
    output: 10,
    reserveInput: 4,
    reserveOutput: 15,
    source: 'https://platform.claude.com/docs/en/models/sonnet-5-5/overview',
    validUntil: '2027-02-23',
  },
} as const;
type Model = keyof typeof MODEL_CATALOG;
/** actual is a conservative usage-based estimate at reservation rates, not an invoice. */
export type Spend = { cap: number; reserved: number; actual: number; calls: number };
export class BudgetError extends Error {
  override name = 'BudgetError';
}
export class ProviderError extends Error {
  override name = 'ProviderError';
}

export class Budget {
  readonly cap: number;
  private pending = new Map<number, number>();
  private used = 0;
  private dispatches = 0;
  constructor(cap: number) {
    if (!Number.isFinite(cap) || cap <= 0 || cap > 10000)
      throw new BudgetError('Spending cap must be a positive USD amount of at most 10000.');
    this.cap = cap;
  }
  reserve(cost: number): number {
    if (!Number.isFinite(cost) || cost < 0)
      throw new BudgetError('The request cost cannot be bounded.');
    const pending = [...this.pending.values()].reduce((a, b) => a + b, 0);
    if (this.used + pending + cost > this.cap + 1e-10)
      throw new BudgetError(
        'The remaining spending cap cannot cover the next request. Draft retained as incomplete.',
      );
    const id = ++this.dispatches;
    this.pending.set(id, cost);
    return id;
  }
  settle(id: number, cost: number): void {
    const reserved = this.pending.get(id);
    if (reserved === undefined || !Number.isFinite(cost) || cost < 0)
      throw new BudgetError('Invalid usage accounting.');
    if (cost > reserved + 1e-10)
      throw new BudgetError(
        'Provider usage exceeded the conservative reservation; further requests stopped.',
      );
    this.pending.delete(id);
    this.used += cost;
  }
  snapshot(): Spend {
    return {
      cap: this.cap,
      reserved: [...this.pending.values()].reduce((a, b) => a + b, 0),
      actual: this.used,
      calls: this.dispatches,
    };
  }
}

export type ProviderOptions = {
  provider: Provider;
  model?: string;
  key: string;
  budget: Budget;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: Date;
  secrets?: readonly string[];
};
const transportSchema = {
  type: 'object',
  properties: {
    payload: {
      type: 'string',
      description:
        'The complete requested JSON document encoded as a JSON string, without Markdown.',
    },
  },
  required: ['payload'],
  additionalProperties: false,
};
const transportResult = z.strictObject({ payload: z.string() });
const MAX_OUTPUT = 24000;
const MAX_REQUEST = 200000;
const PROVIDER_FORMATTING_ALLOWANCE = 32768;
const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
});

function schemaForPrompt(schema: z.ZodType): string {
  return JSON.stringify(
    z.toJSONSchema(schema, { unrepresentable: 'any', cycles: 'ref', reused: 'ref' }),
  );
}

/** A deliberately small transport grammar avoids provider-specific schema limits.
 * The complete typed document is validated locally after decoding payload. */
export class ProviderClient {
  private options: ProviderOptions;
  readonly model: Model;
  constructor(options: ProviderOptions) {
    const name = options.model ?? DEFAULT_MODELS[options.provider];
    if (!(name in MODEL_CATALOG) || MODEL_CATALOG[name as Model].provider !== options.provider)
      throw new ProviderError(
        'Unsupported provider/model combination; use a model in the verified pricing catalog.',
      );
    if (
      (options.now ?? new Date()).getTime() >
      new Date(MODEL_CATALOG[name as Model].validUntil + 'T23:59:59Z').getTime()
    )
      throw new ProviderError(
        'The model pricing catalog has expired. Update verified pricing before paid authoring.',
      );
    if (!options.key || /\s/.test(options.key))
      throw new ProviderError('A provider API key is required.');
    this.options = options;
    this.model = name as Model;
  }
  async complete<T>(schema: z.ZodType<T>, instructions: string, input: unknown): Promise<T> {
    this.options.signal?.throwIfAborted();
    const prompt = JSON.stringify(
      redactValue(input, [this.options.key, ...(this.options.secrets ?? [])]),
    );
    const system =
      instructions +
      '\nReturn a JSON object with a payload string containing the requested document as JSON. The document must satisfy this local schema exactly. Do not invent extra fields.\n' +
      schemaForPrompt(schema);
    const body =
      this.options.provider === 'openai'
        ? {
            model: this.model,
            store: false,
            service_tier: 'default',
            reasoning: { effort: 'low' },
            max_output_tokens: MAX_OUTPUT,
            instructions: system,
            input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
            text: {
              format: {
                type: 'json_schema',
                name: 'provenarium_document',
                strict: true,
                schema: transportSchema,
              },
            },
          }
        : {
            model: this.model,
            max_tokens: MAX_OUTPUT,
            service_tier: 'standard_only',
            system,
            messages: [{ role: 'user', content: prompt }],
            output_config: { format: { type: 'json_schema', schema: transportSchema } },
          };
    const encoded = JSON.stringify(body);
    const bytes = Buffer.byteLength(encoded);
    if (bytes > MAX_REQUEST)
      throw new ProviderError(
        'The selected authoring context exceeds the bounded request size. Select fewer sources or split requirements into smaller families.',
      );
    // One token per UTF-8 byte plus 32K tokens for provider formatting is a deliberately
    // conservative bound for the supported text-only byte-tokenized models. Prices use
    // the highest documented applicable rates, not cache or tier discounts.
    // MAX_REQUEST + allowance = 232,768 input tokens, below OpenAI's documented
    // 272K long-context pricing threshold. Unexpected usage outside this bound
    // retains the reservation and stops authoring rather than reclaiming budget.
    const rates = MODEL_CATALOG[this.model];
    const inputBound = bytes + PROVIDER_FORMATTING_ALLOWANCE;
    const reservation = this.options.budget.reserve(
      (inputBound * rates.reserveInput + MAX_OUTPUT * rates.reserveOutput) / 1e6,
    );
    const endpoint =
      this.options.provider === 'openai'
        ? 'https://api.openai.com/v1/responses'
        : 'https://api.anthropic.com/v1/messages';
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.options.provider === 'openai') headers.authorization = `Bearer ${this.options.key}`;
    else {
      headers['x-api-key'] = this.options.key;
      headers['anthropic-version'] = '2023-06-01';
    }
    let data: Record<string, unknown>;
    try {
      const timeout = AbortSignal.timeout(180000);
      const response = await (this.options.fetchImpl ?? fetch)(endpoint, {
        method: 'POST',
        headers,
        body: encoded,
        redirect: 'error',
        signal: this.options.signal ? AbortSignal.any([this.options.signal, timeout]) : timeout,
      });
      if (!response.ok)
        throw new ProviderError(
          `Provider request returned HTTP ${response.status}. No automatic retry was made.`,
        );
      data = JSON.parse(await boundedResponse(response, 2 * 1024 * 1024)) as Record<
        string,
        unknown
      >;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        this.options.signal?.aborted
          ? 'Authoring cancelled. The last request reservation is retained because billing is uncertain.'
          : 'Provider request failed, timed out, or returned unreadable data. Its reservation is retained; no automatic retry was made.',
      );
    }
    const usage = usageSchema.safeParse(data.usage);
    if (usage.success) {
      // Settle at the SAME conservative rates used to reserve, never at advertised
      // base rates or assumed cache discounts. This avoids reclaiming capacity that
      // could still be billed at a higher applicable input/output rate.
      const u = usage.data;
      const totalInput =
        u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      if (totalInput > inputBound || u.output_tokens > MAX_OUTPUT)
        throw new BudgetError(
          'Provider usage exceeded the documented request bounds. Reservation retained; further requests stopped.',
        );
      const cost = (totalInput * rates.reserveInput + u.output_tokens * rates.reserveOutput) / 1e6;
      this.options.budget.settle(reservation, cost);
    }
    let text: string;
    if (this.options.provider === 'openai') {
      if (data.status !== 'completed')
        throw new ProviderError(
          'Provider output is incomplete or refused. Draft remains incomplete.',
        );
      const blocks = z
        .array(
          z.object({
            type: z.string(),
            content: z
              .array(z.object({ type: z.string(), text: z.string().optional() }))
              .optional(),
          }),
        )
        .safeParse(data.output);
      if (!blocks.success)
        throw new ProviderError('Provider returned an unsupported output structure.');
      if (blocks.data.some((b) => b.content?.some((c) => c.type === 'refusal')))
        throw new ProviderError('Provider refused this authoring request.');
      text = blocks.data
        .flatMap((b) => b.content ?? [])
        .filter((c) => c.type === 'output_text')
        .map((c) => c.text ?? '')
        .join('');
    } else {
      if (data.stop_reason !== 'end_turn')
        throw new ProviderError(
          'Provider output is incomplete or refused. Draft remains incomplete.',
        );
      const blocks = z
        .array(z.object({ type: z.string(), text: z.string().optional() }))
        .safeParse(data.content);
      if (!blocks.success)
        throw new ProviderError('Provider returned an unsupported output structure.');
      text = blocks.data
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
    }
    try {
      const envelope = transportResult.parse(JSON.parse(text));
      return schema.parse(JSON.parse(envelope.payload));
    } catch {
      throw new ProviderError(
        'Provider output failed local schema validation. No generated content was executed.',
      );
    }
  }
}
