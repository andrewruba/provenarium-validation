import { confirm } from '@clack/prompts';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isMap, isNode, isSeq, parseDocument, stringify } from 'yaml';
import type { ContextBundle } from './context.js';
import type { PageObservation } from './authoring/discovery.js';
import { atomicWrite, parseYaml, safePath, writeNew } from './files.js';
import { ursSchema, type Urs } from './schema.js';
import { normalizeGeneratedUrsReferences } from './urs-references.js';
import { editableFile } from './urs-resolve-cli.js';

export type RepairUrsReferencesOptions = {
  root: string;
  file: string;
  context: ContextBundle;
  observation?: PageObservation;
  yes?: boolean;
};
export type RepairUrsReferencesRuntime = {
  isTTY?: boolean;
  confirm?: (options: { message: string; initialValue?: boolean }) => Promise<boolean | symbol>;
  log?: (message: string) => void;
};

function comments(node: unknown): string[] {
  if (!isNode(node)) return [];
  return [
    ...(node.commentBefore ? [node.commentBefore] : []),
    ...(isSeq(node) ? node.items.flatMap(comments) : []),
    ...(isMap(node)
      ? node.items.flatMap((pair) => [...comments(pair.key), ...comments(pair.value)])
      : []),
    ...(node.comment ? [node.comment] : []),
  ];
}

/** Change only the two provenance fields; keep surrounding human text and comments. */
function repairedYaml(raw: string, before: Urs, after: Urs): string {
  const yaml = parseDocument(raw);
  for (let family = 0; family < after.families.length; family++)
    for (let item = 0; item < after.families[family].requirements.length; item++) {
      const previous = before.families[family].requirements[item];
      const next = after.families[family].requirements[item];
      for (const field of ['references', 'citations'] as const) {
        if (JSON.stringify(previous[field]) === JSON.stringify(next[field])) continue;
        const address = ['families', family, 'requirements', item, field];
        const replacement = yaml.createNode(next[field]);
        const notes = comments(yaml.getIn(address));
        if (notes.length) replacement.commentBefore = notes.join('\n');
        yaml.setIn(address, replacement);
      }
    }
  return yaml.toString({ lineWidth: 100 });
}

/** Reviewable, deterministic repair of legacy generated provenance formatting. No provider calls. */
export async function repairUrsReferences(
  options: RepairUrsReferencesOptions,
  runtime: RepairUrsReferencesRuntime = {},
): Promise<void> {
  const root = path.resolve(options.root);
  const file = await editableFile(root, options.file);
  const raw = await readFile(file, 'utf8');
  const before = ursSchema.parse(parseYaml(raw));
  const result = await normalizeGeneratedUrsReferences(before, options);
  const log = runtime.log ?? console.log;
  const assertCurrent = async () => {
    await editableFile(root, file);
    if ((await readFile(file, 'utf8')) !== raw)
      throw new Error(
        'The URS changed during reference repair. No repairs were applied; rerun against the current file.',
      );
  };
  if (!result.changes.length) {
    log(
      result.errors.length
        ? 'No supported reference-format repairs were found. Remaining reference errors require the actual missing source or file.'
        : 'Reference formatting is already valid; no repairs are needed.',
    );
    return;
  }
  await assertCurrent();
  log('Proposed reference-format repairs (requirements and answers stay unchanged)');
  for (let family = 0; family < before.families.length; family++)
    for (let item = 0; item < before.families[family].requirements.length; item++) {
      const previous = before.families[family].requirements[item];
      const next = result.urs.families[family].requirements[item];
      if (JSON.stringify(previous.references) === JSON.stringify(next.references)) continue;
      log(
        `\n${previous.id}\nBefore:\n${stringify({ references: previous.references, citations: previous.citations })}After:\n${stringify({ references: next.references, citations: next.citations })}`,
      );
    }
  if (result.errors.length)
    log(
      `These separate reference errors will remain:\n${result.errors.map((error) => `- ${error}`).join('\n')}`,
    );
  const interactive = runtime.isTTY ?? !!process.stdin.isTTY;
  const accept = runtime.confirm ?? confirm;
  const approved =
    options.yes ||
    (interactive &&
      (await accept({
        message: 'Apply these reference-format repairs and retain a copy of the original YAML?',
        initialValue: false,
      })) === true);
  if (!approved) {
    log('Reference-format repairs were not applied.');
    return;
  }
  await assertCurrent();
  const output = repairedYaml(raw, before, result.urs);
  const identifier = randomUUID();
  const backup = await safePath(root, `.provenarium/reference-repairs/${identifier}.before.yaml`);
  const after = await safePath(root, `.provenarium/reference-repairs/${identifier}.after.yaml`);
  await writeNew(backup, raw);
  await assertCurrent();
  await atomicWrite(file, output);
  await writeNew(after, output);
  log(
    `Repaired ${result.changes.length} reference entries in ${file}. Original: ${backup}\nRepaired copy: ${after}`,
  );
}
