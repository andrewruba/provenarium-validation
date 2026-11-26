import { readFile } from 'node:fs/promises';
import type { ContextBundle } from './context.js';
import type { PageObservation } from './authoring/discovery.js';
import { safePath } from './files.js';
import type { Urs } from './schema.js';

type Citation = Urs['families'][number]['requirements'][number]['citations'][number];
export const APPLICATION_OBSERVATION_SOURCE = '@application';

/** Provenance belongs in citations; references declare normative package inputs. */
export const URS_REFERENCE_INSTRUCTIONS =
  'Use citations for source provenance, including application observations and mentioned test-case IDs. Each citation must use a supplied source ID and location; application observations use source @application and their exact observed URL. references is only for actual normative input files relative to the validation project, or explicit HTTPS/context references that will need retained package copies before approval. Never put labels, descriptive sentences, Markdown links, or test IDs such as OQ-ZERO-VOLUME in references. Do not invent a missing reference file. If a needed source was not supplied, record the missing decision or source as an open question instead.';

function httpsUrl(value: string): URL | undefined {
  if (!/^https:\/\//.test(value) || /\s/.test(value)) return;
  try {
    const url = new URL(value);
    if (url.username || url.password) return;
    return url;
  } catch {
    return;
  }
}

function samePage(left: string, right: string): boolean {
  const a = httpsUrl(left),
    b = httpsUrl(right);
  if (!a || !b) return false;
  a.hash = '';
  b.hash = '';
  return a.href === b.href;
}

function externalReference(reference: string): boolean {
  return Boolean(httpsUrl(reference)) || /^context:[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(reference);
}

/** The same reference checks run on authoring output and on user-invoked urs check. */
export async function checkUrsReference(
  requirement: string,
  reference: string,
  root?: string,
): Promise<string | undefined> {
  if (externalReference(reference)) return;
  if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:|\s)|\s$/.test(reference))
    return `${requirement}: malformed reference ${reference}. Use citations for source descriptions and test IDs.`;
  try {
    // Validate the syntax even when no filesystem root was supplied.
    const file = await safePath(root ?? '.', reference);
    if (root) await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return `${requirement}: missing reference ${reference}`;
    return `${requirement}: unsafe or unreadable reference ${reference}`;
  }
}

export type UrsReferenceNormalization = {
  urs: Urs;
  changes: { requirement: string; reference: string; citations: Citation[] }[];
  errors: string[];
};

/**
 * Repair unambiguous model formatting mistakes using only material actually supplied.
 * Missing normative files remain errors: this never changes acceptance requirements.
 */
export async function normalizeGeneratedUrsReferences(
  input: Urs,
  options: { root: string; context: ContextBundle; observation?: PageObservation },
): Promise<UrsReferenceNormalization> {
  const urs = structuredClone(input);
  const changes: UrsReferenceNormalization['changes'] = [];
  const errors: string[] = [];
  for (const requirement of urs.families.flatMap((family) => family.requirements)) {
    const retained: string[] = [];
    for (const reference of requirement.references) {
      // A real file may legitimately be named after a test case. Never relabel it.
      let readableFile = false;
      if (!externalReference(reference)) {
        try {
          await readFile(await safePath(options.root, reference));
          readableFile = true;
        } catch {
          // An unsafe or missing reference is reported below if it cannot be normalized.
        }
      }
      let citations: Citation[] = [];
      if (!readableFile && !externalReference(reference)) {
        const observation = reference.match(
          /^(?:Hosted observation|Application observation|Observed page):\s*(https:\/\/\S+?)(?:\s+[—–-]\s+.*)?$/i,
        );
        if (observation && httpsUrl(observation[1])) {
          citations = options.context.passages
            .filter((passage) => samePage(passage.location, observation[1]))
            .map(({ source, location }) => ({ source, location }));
          if (
            !citations.length &&
            options.observation &&
            samePage(options.observation.url, observation[1])
          )
            citations.push({
              source: APPLICATION_OBSERVATION_SOURCE,
              location: options.observation.url,
            });
        } else if (/^(?:IQ|OQ|PQ)-[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(reference)) {
          const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const token = new RegExp(`(?:^|[^A-Za-z0-9_.-])${escaped}(?:$|[^A-Za-z0-9_.-])`);
          citations = options.context.passages
            .filter((passage) => token.test(passage.text))
            .map(({ source, location }) => ({ source, location }));
        }
      }
      if (citations.length) {
        const unique = new Map(citations.map((citation) => [JSON.stringify(citation), citation]));
        citations = [...unique.values()];
        for (const citation of citations)
          if (
            !requirement.citations.some(
              (item) => item.source === citation.source && item.location === citation.location,
            )
          )
            requirement.citations.push(citation);
        changes.push({ requirement: requirement.id, reference, citations });
      } else {
        retained.push(reference);
        const error = await checkUrsReference(requirement.id, reference, options.root);
        if (error) errors.push(error);
      }
    }
    requirement.references = retained;
  }
  return { urs, changes, errors };
}
