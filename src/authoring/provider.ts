import { z } from 'zod';
import { boundedResponse, redact, redactValue } from './security.js';
import { compileStructuredOutput } from './structured-output.js';

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
export type ProviderOutputIssue = {
  /** JSON pointer into the invalid envelope or document; empty means its root. */
  path: string;
  code: string;
  message: string;
  expected?: string;
  allowed_values?: (string | number | boolean | null)[];
};
export type ProviderValidationIssue = {
  path: PropertyKey[];
  code: string;
  message: string;
};
type ProviderSchemaFailure =
  'envelope_json' | 'envelope_schema' | 'document_json' | 'document_schema';
type ProviderValidationFailure =
  | 'document_structure'
  | 'protected_expectation'
  | 'draft_assertion_repair'
  | 'protocol_edits'
  | 'urs_resolution';
export type ProviderOutputDiagnostic = {
  request: number;
  operation?: string;
  kind: ProviderSchemaFailure | ProviderValidationFailure | 'provider_http' | 'request_size';
  issues: ProviderOutputIssue[];
  /** Redacted, untrusted output. This is never a validated authoring result. */
  candidate?: unknown;
  raw?: string;
  truncated: boolean;
};
export class ProviderOutputError extends ProviderError {
  override name = 'ProviderOutputError';
  constructor(readonly diagnostic: ProviderOutputDiagnostic) {
    const details = diagnostic.issues
      .slice(0, 4)
      .map((issue) => `${issue.path || '/'}: ${issue.message}`)
      .join('; ');
    super(
      `Provider output failed local schema validation (${diagnostic.kind}). ${details} No generated content was executed.`,
    );
  }
}

export class ProviderRequestSizeError extends ProviderError {
  override name = 'ProviderRequestSizeError';
  constructor(
    readonly diagnostic: ProviderOutputDiagnostic,
    bytes: number,
    limit: number,
  ) {
    super(
      `The assembled authoring request is ${bytes} bytes, above the local ${limit}-byte limit. This includes the document, candidate, context, instructions, and response schema. No request was sent for this step and no budget was reserved. The size breakdown is retained in the authoring record; completed work is unchanged.`,
    );
  }
}

const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_DIAGNOSTIC_ISSUES = 40;
const SENSITIVE_FIELD =
  /^(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|token|secret|cookie|set-cookie)$/i;

function diagnosticRedact(text: string, secrets: readonly string[]): string {
  // Raw malformed JSON may contain escaped credentials that have not been decoded yet.
  const encodedSecrets = secrets.flatMap((secret) => {
    const variants = [secret];
    for (let level = 0; level < 3; level++)
      variants.push(JSON.stringify(variants.at(-1)).slice(1, -1));
    return variants;
  });
  const clean = redact(text, encodedSecrets);
  // A malformed string may have no closing quote, or contain an entire object as
  // its credential. Retain only the prefix instead of guessing where that value ends.
  const sensitive =
    /\\*"(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|token|secret|cookie|set-cookie)\\*"\s*:\s*/i.exec(
      clean,
    );
  const typedSensitive =
    /"key"\s*:\s*"(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|token|secret|cookie|set-cookie)"|"(?:[^"\\]|\\.)*\/(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|token|secret|cookie|set-cookie)"/i.exec(
      clean,
    );
  const cutoff = [sensitive, typedSensitive]
    .filter((match) => match !== null)
    .sort((a, b) => a.index - b.index)[0];
  return cutoff
    ? clean.slice(0, cutoff.index + cutoff[0].length) + '"[REDACTED: remainder omitted]"'
    : clean;
}
function clipDiagnostic(text: string, bytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text);
  return { text: buffer.subarray(0, bytes).toString('utf8'), truncated: buffer.length > bytes };
}
function diagnosticSnapshot(
  value: unknown,
  secrets: readonly string[],
  bytes: number,
): Pick<ProviderOutputDiagnostic, 'candidate' | 'raw' | 'truncated'> {
  let nodes = 0;
  let truncated = false;
  const walk = (item: unknown, depth: number): unknown => {
    if (++nodes > 12000 || depth > 50) {
      truncated = true;
      return '[TRUNCATED]';
    }
    if (typeof item === 'string') return diagnosticRedact(item, secrets);
    if (Array.isArray(item)) return item.map((child) => walk(child, depth + 1));
    if (item && typeof item === 'object') {
      const object = item as Record<string, unknown>;
      const sensitiveEntry = typeof object.key === 'string' && SENSITIVE_FIELD.test(object.key);
      const paths = Array.isArray(object.paths) ? object.paths : undefined;
      const values =
        paths && Array.isArray(object.values)
          ? object.values.map((value, index) => {
              const segments =
                typeof paths[index] === 'string'
                  ? paths[index]
                      .split('/')
                      .map((part: string) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
                  : [];
              return segments.some((segment: string) => SENSITIVE_FIELD.test(segment))
                ? '[REDACTED]'
                : value;
            })
          : undefined;
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [
          diagnosticRedact(key, secrets),
          SENSITIVE_FIELD.test(key) || (key === 'value' && sensitiveEntry)
            ? '[REDACTED]'
            : walk(key === 'values' && values ? values : child, depth + 1),
        ]),
      );
    }
    return item;
  };
  const candidate = walk(value, 0);
  const serialized = JSON.stringify(candidate);
  if (Buffer.byteLength(serialized) > bytes)
    return { raw: diagnosticRaw(serialized, bytes).text, truncated: true };
  return { candidate, truncated };
}
/** Bound the serialized string, including JSON escaping, rather than only its content. */
function diagnosticRaw(text: string, bytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(JSON.stringify(text)) <= bytes) return { text, truncated: false };
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(text.slice(0, mid))) <= bytes) low = mid;
    else high = mid - 1;
  }
  return { text: text.slice(0, low), truncated: true };
}
function diagnosticIssueCollector(secrets: readonly string[]) {
  const result: ProviderOutputIssue[] = [];
  let truncated = false;
  let issueBytes = 0;
  const safe = (value: string, limit = 500) => {
    const clipped = clipDiagnostic(diagnosticRedact(value, secrets), limit);
    truncated ||= clipped.truncated;
    return clipped.text;
  };
  const pointer = (parts: PropertyKey[]) =>
    safe(
      parts.map((part) => '/' + String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join(''),
      1000,
    );
  const add = (issue: ProviderOutputIssue) => {
    const bytes = Buffer.byteLength(JSON.stringify(issue)) + 1;
    if (result.length >= MAX_DIAGNOSTIC_ISSUES || issueBytes + bytes > 16 * 1024) {
      truncated = true;
      return;
    }
    issueBytes += bytes;
    result.push(issue);
  };
  return {
    safe,
    pointer,
    add,
    full: () => result.length >= MAX_DIAGNOSTIC_ISSUES,
    truncate: () => {
      truncated = true;
    },
    finish: () => ({ issues: result, truncated }),
  };
}
function diagnosticIssues(
  issues: readonly z.core.$ZodIssue[],
  secrets: readonly string[],
): { issues: ProviderOutputIssue[]; truncated: boolean } {
  const collector = diagnosticIssueCollector(secrets);
  const { safe, pointer, add } = collector;
  const visit = (issue: z.core.$ZodIssue, prefix: PropertyKey[] = []) => {
    if (collector.full()) {
      collector.truncate();
      return;
    }
    const path = [...prefix, ...issue.path];
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys)
        add({
          path: pointer([...path, key]),
          code: issue.code,
          message: 'Unexpected field; remove it.',
        });
      return;
    }
    const values =
      issue.code === 'invalid_value'
        ? issue.values
        : issue.code === 'invalid_union' && 'options' in issue
          ? issue.options
          : undefined;
    if (values && values.length > 30) collector.truncate();
    const allowed = values
      ?.slice(0, 30)
      .map((value) =>
        typeof value === 'string'
          ? safe(value, 200)
          : typeof value === 'number' || typeof value === 'boolean' || value === null
            ? value
            : safe(String(value), 200),
      );
    add({
      path: pointer(path),
      code: issue.code,
      message: safe(issue.message),
      ...(issue.code === 'invalid_type' ? { expected: safe(issue.expected) } : {}),
      ...(allowed?.length ? { allowed_values: allowed } : {}),
    });
    if (issue.code === 'invalid_union')
      for (const branch of issue.errors) for (const child of branch) visit(child, path);
    if (issue.code === 'invalid_key' || issue.code === 'invalid_element')
      for (const child of issue.issues) visit(child, path);
  };
  for (const issue of issues) visit(issue);
  return collector.finish();
}
function validationIssues(
  issues: readonly ProviderValidationIssue[],
  secrets: readonly string[],
): { issues: ProviderOutputIssue[]; truncated: boolean } {
  const collector = diagnosticIssueCollector(secrets);
  for (const issue of issues) {
    if (collector.full()) {
      collector.truncate();
      break;
    }
    collector.add({
      path: collector.pointer(issue.path),
      code: collector.safe(issue.code, 100),
      message: collector.safe(issue.message),
    });
  }
  return collector.finish();
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
const MAX_OUTPUT = 24000;
const MAX_REQUEST = 200000;
const PROVIDER_FORMATTING_ALLOWANCE = 32768;
const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
});

/** Native JSON schemas constrain the document during generation. Local validation
 * still enforces refinements and the domain's cross-field rules after decoding. */
export class ProviderClient {
  private options: ProviderOptions;
  readonly model: Model;
  readonly diagnostics: ProviderOutputDiagnostic[] = [];
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
  private retainDiagnostic(
    kind: ProviderOutputDiagnostic['kind'],
    value: unknown,
    parsedIssues: { issues: ProviderOutputIssue[]; truncated: boolean },
    raw = false,
    operation?: string,
  ): ProviderOutputDiagnostic {
    const secrets = [this.options.key, ...(this.options.secrets ?? [])];
    const label =
      operation === undefined
        ? undefined
        : clipDiagnostic(diagnosticRedact(operation, secrets), 256);
    const metadata = {
      request: this.options.budget.snapshot().calls,
      kind,
      issues: parsedIssues.issues,
      ...(label ? { operation: label.text } : {}),
    };
    // Leave space for the snapshot property, truncated flag, and a later operation label.
    const remaining = MAX_DIAGNOSTIC_BYTES - Buffer.byteLength(JSON.stringify(metadata)) - 1024;
    const snapshot = raw
      ? (() => {
          const clipped = diagnosticRaw(diagnosticRedact(String(value), secrets), remaining);
          return { raw: clipped.text, truncated: clipped.truncated };
        })()
      : diagnosticSnapshot(value, secrets, remaining);
    const diagnostic: ProviderOutputDiagnostic = {
      ...metadata,
      ...snapshot,
      truncated: snapshot.truncated || parsedIssues.truncated || Boolean(label?.truncated),
    };
    this.diagnostics.push(diagnostic);
    return diagnostic;
  }
  private outputError(
    kind: ProviderSchemaFailure,
    value: unknown,
    issues?: readonly z.core.$ZodIssue[],
    raw = false,
  ): ProviderOutputError {
    const secrets = [this.options.key, ...(this.options.secrets ?? [])];
    const parsedIssues = issues
      ? diagnosticIssues(issues, secrets)
      : {
          issues: [
            {
              path: '',
              code: 'invalid_json',
              message: 'Expected valid JSON without Markdown or surrounding commentary.',
            },
          ],
          truncated: false,
        };
    return new ProviderOutputError(this.retainDiagnostic(kind, value, parsedIssues, raw));
  }
  /** HTTP errors describe the rejected request, not generated content. Preserve only
   * bounded, redacted provider error fields; never copy a raw body or request. */
  private async httpError(response: Response): Promise<ProviderError> {
    const secrets = [this.options.key, ...(this.options.secrets ?? [])];
    let truncated = false;
    const safe = (value: unknown, limit: number): string | undefined => {
      if (typeof value !== 'string') return undefined;
      const clean = diagnosticRedact(value, secrets).replace(
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu,
        '',
      );
      const clipped = clipDiagnostic(clean, limit);
      truncated ||= clipped.truncated;
      return clipped.text;
    };
    let body: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(await boundedResponse(response, MAX_DIAGNOSTIC_BYTES));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        body = parsed as Record<string, unknown>;
    } catch {
      // HTML, malformed JSON, oversized bodies, and failed reads retain metadata only.
      await response.body?.cancel().catch(() => undefined);
    }
    const source =
      body?.error && typeof body.error === 'object' && !Array.isArray(body.error)
        ? (body.error as Record<string, unknown>)
        : {};
    const error: Record<string, string> = {};
    for (const [key, limit] of [
      ['type', 128],
      ['code', 128],
      ['param', 512],
      ['message', 8192],
    ] as const) {
      const value = safe(source[key], limit);
      if (value !== undefined) error[key] = value;
    }
    const requestId = safe(
      response.headers.get('x-request-id') ??
        response.headers.get('request-id') ??
        body?.request_id,
      256,
    );
    const diagnostic = this.retainDiagnostic(
      'provider_http',
      {
        provider: this.options.provider,
        model: this.model,
        status: response.status,
        ...(requestId ? { request_id: requestId } : {}),
        error,
      },
      validationIssues(
        [
          {
            path: ['error'],
            code: error.code || error.type || `http_${response.status}`,
            message:
              error.message || 'Provider rejected the request without readable error details.',
          },
        ],
        secrets,
      ),
      false,
      'provider request',
    );
    diagnostic.truncated ||= truncated;
    const summary = error.message ? clipDiagnostic(error.message, 2000) : undefined;
    const details = [
      summary?.text,
      ...(summary?.truncated ? ['Further details are retained in the authoring record.'] : []),
      ...(['type', 'code', 'param'] as const).flatMap((field) =>
        error[field] ? [`${field}: ${error[field]}`] : [],
      ),
      ...(requestId ? [`request ID: ${requestId}`] : []),
    ]
      .filter(Boolean)
      .join('; ');
    return new ProviderError(
      `Provider request returned HTTP ${response.status}.${details ? ` ${details}` : ''} No automatic retry was made.`,
    );
  }
  /** Retain local structural or preservation failures without throwing or dispatching a request. */
  recordValidationFailure(
    kind: ProviderValidationFailure,
    operation: string,
    candidate: unknown,
    issues: readonly ProviderValidationIssue[],
  ): ProviderOutputDiagnostic {
    const secrets = [this.options.key, ...(this.options.secrets ?? [])];
    return this.retainDiagnostic(
      kind,
      candidate,
      validationIssues(issues, secrets),
      false,
      operation,
    );
  }
  async complete<T>(schema: z.ZodType<T>, instructions: string, input: unknown): Promise<T> {
    this.options.signal?.throwIfAborted();
    const cleanInput = redactValue(input, [this.options.key, ...(this.options.secrets ?? [])]);
    const prompt = JSON.stringify(cleanInput) ?? 'null';
    let contract: ReturnType<typeof compileStructuredOutput<T>>;
    try {
      contract = compileStructuredOutput(schema, this.options.provider);
    } catch {
      throw new ProviderError(
        'The authoring schema cannot be represented by the supported native structured-output contract. No request was sent.',
      );
    }
    const system =
      instructions +
      '\nReturn the requested typed document using the supplied native JSON schema, without Markdown or JSON-encoded document strings. Omit unused optional keys where the schema permits; for required optional-field placeholders, use the null/presence representation described by their schema. The caller applies defaults and validates all local refinements after decoding.';
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
                schema: contract.schema,
              },
            },
          }
        : {
            model: this.model,
            max_tokens: MAX_OUTPUT,
            service_tier: 'standard_only',
            system,
            messages: [{ role: 'user', content: prompt }],
            output_config: { format: { type: 'json_schema', schema: contract.schema } },
          };
    const encoded = JSON.stringify(body);
    const bytes = Buffer.byteLength(encoded);
    if (bytes > MAX_REQUEST) {
      // Retain sizes only, never an additional copy of the input or credential material.
      const diagnostic = this.retainDiagnostic(
        'request_size',
        {
          request_bytes: bytes,
          limit_bytes: MAX_REQUEST,
          input_json_bytes: Buffer.byteLength(prompt),
          instructions_bytes: Buffer.byteLength(system),
          response_schema_bytes: Buffer.byteLength(JSON.stringify(contract.schema)),
          input_field_json_bytes:
            cleanInput && typeof cleanInput === 'object' && !Array.isArray(cleanInput)
              ? Object.fromEntries(
                  Object.entries(cleanInput)
                    .filter(([, value]) => value !== undefined)
                    .map(([name, value]) => [name, Buffer.byteLength(JSON.stringify(value))]),
                )
              : undefined,
        },
        {
          issues: [
            {
              path: '',
              code: 'request_too_large',
              message: `Assembled request ${bytes} bytes exceeds local ${MAX_REQUEST}-byte limit before dispatch.`,
            },
          ],
          truncated: false,
        },
        false,
        'request preparation',
      );
      throw new ProviderRequestSizeError(diagnostic, bytes, MAX_REQUEST);
    }
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
      if (!response.ok) throw await this.httpError(response);
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
      if (
        blocks.data.some(
          (b) => b.type === 'refusal' || b.content?.some((c) => c.type === 'refusal'),
        )
      )
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
      if (blocks.data.some((b) => b.type === 'refusal'))
        throw new ProviderError('Provider refused this authoring request.');
      text = blocks.data
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
    }
    let wireValue: unknown;
    try {
      wireValue = JSON.parse(text);
    } catch {
      throw this.outputError('document_json', text, undefined, true);
    }
    const wire = contract.wireSchema.safeParse(wireValue);
    if (!wire.success) throw this.outputError('document_schema', wireValue, wire.error.issues);
    let candidate: unknown;
    try {
      candidate = contract.decode(wire.data);
    } catch (error) {
      throw this.outputError(
        'document_schema',
        wireValue,
        error instanceof z.ZodError
          ? error.issues
          : [
              {
                code: 'custom',
                path: [],
                message: 'Typed output could not be decoded into the requested document.',
              },
            ],
      );
    }
    let document: z.ZodSafeParseResult<T>;
    try {
      document = schema.safeParse(candidate);
    } catch {
      // Custom refinements and pathological nesting can throw; their exception may
      // echo untrusted values. Keep a bounded candidate without retaining that exception.
      throw this.outputError('document_schema', candidate, [
        {
          code: 'custom',
          path: [],
          message: 'Output could not be validated against the requested schema.',
        },
      ]);
    }
    if (!document.success)
      throw this.outputError('document_schema', candidate, document.error.issues);
    return document.data;
  }
}
