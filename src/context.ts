import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { load } from 'cheerio';
import { contextSourceSchema, type ContextSource } from './schema.js';
import { boundedResponse, redact, safeUrl } from './authoring/security.js';

export type ContextPassage = { source: string; location: string; text: string };
export type ContextHash = { source: string; location: string; sha256: string };
export type ContextBundle = {
  passages: ContextPassage[];
  hashes: ContextHash[];
  warnings: string[];
};
export type ContextOptions = {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  maxFiles?: number;
  maxCharacters?: number;
};
const TEXT = new Set([
  '.md',
  '.txt',
  '.csv',
  '.tsv',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.html',
  '.htm',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.sql',
  '.r',
  '.css',
  '.scss',
  '.sh',
]);
const EXCLUDED =
  /^(?:\..*|node_modules|vendor|dist|build|coverage|target|__pycache__|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i;
const SECRET_FILE =
  /(?:^|[._-])(?:credentials?|secrets?|passwords?|tokens?|private[_-]?key|service[_-]?account|auth[_-]?state|storage[_-]?state)(?:[._-]|$)|\.(?:pem|key|p12|pfx|keystore)$/i;
const MAX_FILE = 5 * 1024 * 1024;

function htmlText(html: string): string {
  const $ = load(html);
  $('script,style,noscript,template,input[type=password],input[type=hidden]').remove();
  $('tr').each((_i, row) => {
    $(row).append('\n');
  });
  $('td,th').each((_i, cell) => {
    $(cell).append(' | ');
  });
  $('p,li,h1,h2,h3,h4,div,section').each((_i, el) => {
    $(el).append('\n');
  });
  return $('body')
    .text()
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim();
}

async function extractFile(
  bytes: Buffer,
  extension: string,
): Promise<{ text: string; warnings: string[] }> {
  if (extension === '.docx') {
    const mammoth = await import('mammoth');
    const result = await mammoth.convertToHtml({ buffer: bytes });
    return { text: htmlText(result.value), warnings: result.messages.map((m) => m.message) };
  }
  if (extension === '.pdf') {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    const document = await task.promise;
    const pages: string[] = [];
    try {
      for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, 100); pageNumber++) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        pages.push(
          `[Page ${pageNumber}]\n` +
            content.items
              .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
              .join(''),
        );
      }
      return {
        text: pages.join('\n\n'),
        warnings: document.numPages > 100 ? ['Only the first 100 PDF pages were extracted.'] : [],
      };
    } finally {
      await task.destroy();
    }
  }
  if (!TEXT.has(extension)) throw new Error('Unsupported context format.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\0')) throw new Error('Binary content is not supported.');
  return { text: ['.html', '.htm'].includes(extension) ? htmlText(text) : text, warnings: [] };
}

export async function extractContext(
  root: string,
  sources: ContextSource[],
  selected?: string[],
  options: ContextOptions = {},
): Promise<ContextBundle> {
  const bundle: ContextBundle = { passages: [], hashes: [], warnings: [] };
  const maxFiles = options.maxFiles ?? 80;
  const maxCharacters = options.maxCharacters ?? 120_000;
  let files = 0,
    characters = 0;
  const ids = new Set(sources.map((s) => s.id));
  if (selected?.some((id) => !ids.has(id)))
    throw new Error('A selected context source does not exist.');
  const chosen = sources.filter((s) => !selected || selected.includes(s.id));
  const accept = async (source: string, location: string, bytes: Buffer, extension: string) => {
    if (files >= maxFiles || characters >= maxCharacters) {
      bundle.warnings.push(
        `${source}: extraction limit reached; ${location} was not read into authoring context.`,
      );
      return;
    }
    const result = await extractFile(bytes, extension);
    let value = redact(result.text);
    if (
      !value.trim() ||
      (extension === '.pdf' && value.replace(/\[Page \d+\]/g, '').trim().length < 10)
    )
      throw new Error('No readable text; scanned or empty documents require a text export.');
    const limit = Math.min(32_000, maxCharacters - characters);
    if (value.length > limit) {
      value = value.slice(0, limit);
      bundle.warnings.push(`${source}: ${location} was partially extracted (${limit} characters).`);
    }
    result.warnings.forEach((w) => bundle.warnings.push(`${source}: ${location}: ${w}`));
    files++;
    characters += value.length;
    bundle.passages.push({ source, location, text: value });
    bundle.hashes.push({
      source,
      location,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  };
  for (const rawSource of chosen) {
    options.signal?.throwIfAborted();
    const source = contextSourceSchema.parse(rawSource);
    try {
      if (source.url) {
        const url = safeUrl(source.url);
        if (url.protocol !== 'https:') throw new Error('Context URLs must use HTTPS.');
        const response = await (options.fetchImpl ?? fetch)(url, {
          signal: options.signal
            ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
            : AbortSignal.timeout(30_000),
          redirect: 'error',
          headers: { accept: 'text/html,text/plain' },
        });
        if (!response.ok) throw new Error(`Context HTTP request returned ${response.status}.`);
        const contentType = response.headers.get('content-type') ?? '';
        if (!/text\/(html|plain|markdown)|application\/(json|xml)/i.test(contentType))
          throw new Error('URL is not readable HTML/text; link a local export.');
        const value = await boundedResponse(response, MAX_FILE);
        await accept(
          source.id,
          url.href,
          Buffer.from(value),
          /html/i.test(contentType) ? '.html' : '.txt',
        );
      } else {
        const linked = path.resolve(root, source.path!);
        if (
          SECRET_FILE.test(path.basename(linked)) ||
          path.basename(linked).startsWith('.env') ||
          linked
            .split(path.sep)
            .some((part) => ['.provenarium', '.aws', '.ssh', '.git', '.codex'].includes(part))
        )
          throw new Error(
            'Credential, environment, and authentication-storage files are excluded from authoring context.',
          );
        const linkedStat = await lstat(linked);
        if (linkedStat.isSymbolicLink()) throw new Error('Linked context must not be a symlink.');
        const boundary = await realpath(linked);
        const walk = async (current: string, depth: number): Promise<void> => {
          options.signal?.throwIfAborted();
          const name = path.basename(current);
          if (
            SECRET_FILE.test(name) ||
            (depth > 0 && EXCLUDED.test(name)) ||
            name.startsWith('.env')
          )
            return;
          if (depth > 12) {
            bundle.warnings.push(`${source.id}: directory-depth limit reached.`);
            return;
          }
          const stat = await lstat(current);
          if (stat.isSymbolicLink()) {
            bundle.warnings.push(
              `${source.id}: skipped symlink ${path.relative(boundary, current)}.`,
            );
            return;
          }
          const resolved = await realpath(current);
          if (resolved !== boundary && !resolved.startsWith(boundary + path.sep))
            throw new Error('Context path escapes linked scope.');
          if (stat.isDirectory()) {
            for (const entry of (await readdir(current)).sort()) {
              if (files >= maxFiles || characters >= maxCharacters) {
                bundle.warnings.push(
                  `${source.id}: directory only partially extracted because the context limit was reached.`,
                );
                break;
              }
              await walk(path.join(current, entry), depth + 1);
            }
          } else if (stat.isFile()) {
            const extension = path.extname(current).toLowerCase();
            if (!TEXT.has(extension) && extension !== '.docx' && extension !== '.pdf') {
              bundle.warnings.push(
                `${source.id}: unsupported format ${path.relative(root, current)}.`,
              );
              return;
            }
            if (stat.size > MAX_FILE) {
              bundle.warnings.push(
                `${source.id}: skipped oversized file ${path.relative(root, current)}.`,
              );
              return;
            }
            const bytes = await readFile(current);
            try {
              await accept(
                source.id,
                path.relative(root, current) || path.basename(current),
                bytes,
                extension,
              );
            } catch (error) {
              bundle.warnings.push(
                `${source.id}: ${path.relative(root, current)}: ${error instanceof Error ? error.message : 'Extraction failed.'}`,
              );
            }
          }
        };
        await walk(linked, 0);
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
      bundle.warnings.push(
        `${source.id}: ${error instanceof Error ? redact(error.message) : 'Source could not be read.'}`,
      );
    }
  }
  return bundle;
}
