import { createHash } from 'node:crypto';
import type { ContextHash } from '../context.js';
import { assertAllowedUrl } from './security.js';

export type SourceCorrespondence = {
  source: string;
  location: string;
  sha256: string;
  deployed_url: string;
};

async function scriptBytes(response: Response) {
  const limit = 2 * 1024 * 1024;
  if (!response.body || Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('Script exceeds correspondence limit.');
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('Script exceeds correspondence limit.');
      parts.push(value);
    }
    return Buffer.concat(parts);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Compare bytes, never execute or send fetched script bodies to the provider.
 * A match identifies only that script, not the entire build or scientific correctness. */
export async function matchDeployedScripts(
  scripts: string[],
  hashes: ContextHash[],
  target: string,
  origins: string[],
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<SourceCorrespondence[]> {
  const byHash = new Map<string, ContextHash[]>();
  for (const hash of hashes) {
    if (!/\.[cm]?js$/i.test(hash.location)) continue;
    byHash.set(hash.sha256, [...(byHash.get(hash.sha256) ?? []), hash]);
  }
  if (!byHash.size) return [];
  const matches: SourceCorrespondence[] = [];
  const deadline = AbortSignal.timeout(15_000);
  for (const script of [...new Set(scripts)].slice(0, 16)) {
    options.signal?.throwIfAborted();
    if (deadline.aborted) break;
    try {
      let url = assertAllowedUrl(script, target, origins);
      for (let redirects = 0; redirects <= 3; redirects++) {
        const response = await (options.fetchImpl ?? fetch)(url, {
          redirect: 'manual',
          signal: AbortSignal.any([
            deadline,
            AbortSignal.timeout(5000),
            ...(options.signal ? [options.signal] : []),
          ]),
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const destination = response.headers.get('location');
          await response.body?.cancel();
          if (!destination) break;
          url = assertAllowedUrl(destination, url, origins);
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          break;
        }
        const source = await scriptBytes(response);
        const sha256 = createHash('sha256').update(source).digest('hex');
        for (const local of byHash.get(sha256) ?? []) matches.push({ ...local, deployed_url: url });
        break;
      }
    } catch {
      options.signal?.throwIfAborted();
      // An unavailable/different asset is not affirmative evidence of a match.
    }
  }
  return matches;
}
