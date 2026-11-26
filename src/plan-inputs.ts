import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { safePath, sha256 } from './files.js';
import type { Plan, Urs } from './schema.js';

export const PLAN_INPUT_INSTRUCTIONS =
  'plan.references and plan.fixtures contain file paths, never prose, document titles, test IDs, URLs, execution instructions, or approval gates. Every existing normative reference must be selected verbatim from available_reference_files and declared in plan.references. The reviewed URS is already included in the package: do not add its title or urs.yaml as a reference. Source provenance belongs in case citations. New text inputs must be emitted in fixtures with safe fixtures/ paths and declared in plan.fixtures or plan.references. Do not replace a supplied normative reference with model-generated content. Missing scientific evidence is a specific unresolved requirement decision; never invent a file, approval, independent review, or authoritative reference. Technical schema or file-path corrections are the generator’s responsibility, not questions for the user.';

const RESERVED = new Set([
  'urs.yaml',
  'plan.json',
  'ioq.html',
  'ioq.pdf',
  'urs.html',
  'questions.json',
  'context-hashes.json',
  'candidate.json',
  'approval.json',
  'changes.json',
]);

/** Package input syntax, checked without opening model-selected paths. */
export function planInputPathError(input: string): string | undefined {
  if (
    !input ||
    input !== input.trim() ||
    path.isAbsolute(input) ||
    input.includes('\\') ||
    input.includes('\0') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(input) ||
    input.split('/').some((part) => !part || part === '..' || part.startsWith('.'))
  )
    return 'must be a safe project-relative file path';
  if (RESERVED.has(input) || input.startsWith('tests/'))
    return 'uses a generated package artifact or reserved path';
}

export type PlanInputReference = {
  path: string;
  requirements: string[];
  sha256: string;
};
export type PlanInputCatalog = {
  references: PlanInputReference[];
  errors: string[];
};
export type GeneratedPlanInputs = {
  plan: Pick<Plan, 'fixtures' | 'references'>;
  fixtures: { path: string; content: string }[];
};

async function inputHash(root: string, input: string): Promise<string> {
  const file = await safePath(root, input);
  if (!(await lstat(file)).isFile()) throw new Error('Not a regular file.');
  return sha256(await readFile(file));
}

/** Only reviewed URS declarations authorize existing files. Never scan the project or home. */
export async function collectPlanInputCatalog(root: string, urs: Urs): Promise<PlanInputCatalog> {
  const required = new Map<string, Set<string>>();
  for (const requirement of urs.families.flatMap((family) => family.requirements))
    for (const reference of requirement.references) {
      const ids = required.get(reference) ?? new Set<string>();
      ids.add(requirement.id);
      required.set(reference, ids);
    }
  const references: PlanInputReference[] = [];
  const errors: string[] = [];
  for (const [input, requirements] of required) {
    const label = [...requirements].join(', ');
    const invalid = planInputPathError(input);
    if (invalid) {
      errors.push(
        `${label}: normative reference ${JSON.stringify(input)} ${invalid}. Retain the actual normative material in a project-relative file before generating the protocol.`,
      );
      continue;
    }
    try {
      references.push({
        path: input,
        requirements: [...requirements],
        sha256: await inputHash(root, input),
      });
    } catch {
      errors.push(
        `${label}: missing, unsafe, or unreadable normative input ${JSON.stringify(input)}. Supply the actual reference file; the generator cannot substitute invented evidence.`,
      );
    }
  }
  return { references, errors };
}

/** Reject undeclared model paths before any filesystem read, then verify authorized inputs. */
export async function validateGeneratedPlanInputs(
  root: string,
  generated: GeneratedPlanInputs,
  catalog: PlanInputCatalog,
): Promise<string[]> {
  const errors = [...catalog.errors];
  const allowed = new Map(catalog.references.map((reference) => [reference.path, reference]));
  const created = new Set<string>();
  for (const fixture of generated.fixtures) {
    const invalid = planInputPathError(fixture.path);
    if (invalid || !/^fixtures\/[A-Za-z0-9_./-]+\.(csv|tsv|json|txt|md)$/.test(fixture.path))
      errors.push(
        `Generated input ${JSON.stringify(fixture.path)} must use a safe fixtures/ text-file path.`,
      );
    if (created.has(fixture.path))
      errors.push(`Generated input ${JSON.stringify(fixture.path)} is repeated.`);
    if (allowed.has(fixture.path))
      errors.push(
        `Generated input ${JSON.stringify(fixture.path)} would replace a supplied normative reference.`,
      );
    created.add(fixture.path);
  }
  const declared = new Set<string>();
  for (const [kind, inputs] of [
    ['fixtures', generated.plan.fixtures],
    ['references', generated.plan.references],
  ] as const)
    for (const input of inputs) {
      if (declared.has(input))
        errors.push(`Plan input ${JSON.stringify(input)} is declared more than once.`);
      declared.add(input);
      const invalid = planInputPathError(input);
      if (invalid) {
        errors.push(
          `plan.${kind} entry ${JSON.stringify(input)} ${invalid}. Use source citations or protocol text for descriptions.`,
        );
        continue;
      }
      if (kind === 'fixtures' && !created.has(input))
        errors.push(
          `plan.fixtures entry ${JSON.stringify(input)} has no generated fixture content.`,
        );
      if (kind === 'references' && !allowed.has(input) && !created.has(input))
        errors.push(
          `plan.references entry ${JSON.stringify(input)} is not an authorized normative input or generated fixture. Select an exact path from available_reference_files; do not use document descriptions or missing files.`,
        );
    }
  for (const input of created)
    if (!declared.has(input))
      errors.push(
        `Generated input ${JSON.stringify(input)} is not declared in plan.fixtures or plan.references.`,
      );
  for (const reference of catalog.references) {
    if (!generated.plan.references.includes(reference.path))
      errors.push(
        `Normative input ${JSON.stringify(reference.path)} required by ${reference.requirements.join(', ')} is missing from plan.references.`,
      );
    try {
      if ((await inputHash(root, reference.path)) !== reference.sha256)
        errors.push(
          `Normative input ${JSON.stringify(reference.path)} changed during authoring. Regenerate against the current reference.`,
        );
    } catch {
      errors.push(
        `Normative input ${JSON.stringify(reference.path)} is no longer a readable regular file inside the project.`,
      );
    }
  }
  return [...new Set(errors)];
}
