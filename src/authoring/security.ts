/** Text sent to providers and retained authoring diagnostics passes this boundary. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let value = text;
  for (const secret of secrets.filter((s) => s.length > 0).sort((a, b) => b.length - a.length)) {
    value = value.split(secret).join('[REDACTED]');
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) value = value.split(encoded).join('[REDACTED]');
  }
  return value
    .replace(
      /\b(sk-(?:ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g,
      '[REDACTED]',
    )
    .replace(/(authorization\s*[:=]\s*["']?(?:bearer|basic)\s+)[^\s"',;]+/gi, '$1[REDACTED]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]\s*)(["'])(.*?)\2/gi,
      '$1$2[REDACTED]$2',
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]\s*)([^\s,"';<>]+)/gi,
      '$1[REDACTED]',
    );
}

export function redactValue<T>(input: T, secrets: readonly string[] = []): T {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return redact(value, secrets);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [redact(key, secrets), walk(item)]),
      );
    return value;
  };
  return walk(input) as T;
}

export function safeUrl(input: string, base?: string): URL {
  const url = new URL(input, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Only HTTP(S) URLs without embedded credentials are supported.');
  for (const key of url.searchParams.keys()) {
    if (/token|password|secret|key|auth|session|credential/i.test(key))
      throw new Error('URLs containing authentication material are not allowed.');
  }
  return url;
}

export function assertAllowedUrl(input: string, base: string, origins: readonly string[]): string {
  const url = safeUrl(input, base);
  if (!origins.includes(url.origin))
    throw new Error('Requested origin is outside the declared discovery scope.');
  return url.href;
}

export async function boundedResponse(
  response: Response,
  maxBytes = 2 * 1024 * 1024,
): Promise<string> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes || !response.body)
    throw new Error('Response exceeds the supported size or has no body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error('Response exceeds the supported size.');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString('utf8');
}
