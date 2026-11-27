import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { safePath, readJson, sha256 } from '../files.js';
import { type Urs, contextHashSchema } from '../schema.js';
import type { ContextHash } from '../context.js';
import { generatedPlanSchema, type GeneratedPlan, type ProviderOutputDiagnostic } from './index.js';
import { applyPlanEdits, planEditsSchema, type PlanEdits } from './plan-edits.js';
import { validatePlanStructure } from '../compiler.js';

const checkpointSchema = z.strictObject({
  schema_version: z.literal(1),
  urs_sha256: z.string(),
  base_sha256: z.string(),
  target_url: z.string(),
  context_hashes: z.array(contextHashSchema),
  proposals: z.array(planEditsSchema).max(100),
  checkpoint: generatedPlanSchema,
});
export type AutomationCheckpoint = z.infer<typeof checkpointSchema>;
export type AutomationResume = {
  file: string;
  value: GeneratedPlan;
  checkpoint: AutomationCheckpoint;
  converted: number;
};
const hash = (value: unknown) => sha256(JSON.stringify(value));
const sortedHashes = (hashes: ContextHash[]) =>
  [...hashes].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const automationProposal = (proposal: PlanEdits) =>
  proposal.edits.length > 0 &&
  proposal.edits.every((e) => e.op === 'automate_case' || e.op === 'add_fixture');

function replay(
  base: GeneratedPlan,
  urs: Urs,
  proposals: PlanEdits[],
  contextHashes: ContextHash[],
  target: string,
) {
  let value = structuredClone(base);
  value.plan.target = { url: new URL(target).href, allowed_origins: [new URL(target).origin] };
  value.plan.urs_revision = urs.document.revision;
  for (const proposal of proposals) {
    if (!automationProposal(proposal))
      throw new Error('Only completed automation conversions can be resumed.');
    value = applyPlanEdits(value, proposal, {
      urs,
      mode: 'review',
      allowManualConversion: true,
    }).value;
  }
  value.plan.context_hashes = contextHashes;
  if (validatePlanStructure(value.plan, urs).length)
    throw new Error('Retained conversions no longer validate.');
  return value;
}

export function automationCheckpoint(options: {
  base: GeneratedPlan;
  urs: Urs;
  target: string;
  contextHashes: ContextHash[];
  prior?: AutomationCheckpoint;
  diagnostics?: ProviderOutputDiagnostic[];
  proposals?: PlanEdits[];
}): AutomationCheckpoint | undefined {
  const proposals = [...(options.prior?.proposals ?? [])];
  if (options.proposals) proposals.push(...options.proposals);
  else
    for (const diagnostic of options.diagnostics ?? []) {
      if (diagnostic.kind !== 'protocol_edits') continue;
      const candidate = diagnostic.candidate as { proposal?: unknown } | undefined;
      const parsed = planEditsSchema.safeParse(candidate?.proposal);
      // Legacy records contain proposals only in their bounded diagnostics.
      if (!parsed.success || !automationProposal(parsed.data)) break;
      proposals.push(parsed.data);
    }
  if (!proposals.length) return;
  try {
    const checkpoint = replay(
      options.base,
      options.urs,
      proposals,
      options.contextHashes,
      options.target,
    );
    return {
      schema_version: 1,
      urs_sha256: hash(options.urs),
      base_sha256: hash(options.base),
      target_url: new URL(options.target).href,
      context_hashes: options.contextHashes,
      proposals,
      checkpoint,
    };
  } catch {
    return;
  }
}

/** Resume only replayable conversions against the unchanged current candidate and inputs.
 * Retained drafts remain unapproved; this never replaces an approved package. */
export async function findAutomationResume(options: {
  root: string;
  base: GeneratedPlan;
  urs: Urs;
  previousUrs: Urs;
  target: string;
  contextHashes: ContextHash[];
  inputsModifiedAt: number;
}): Promise<AutomationResume | undefined> {
  const directory = await safePath(options.root, 'drafts');
  let files: { file: string; modified: number }[];
  try {
    files = (
      await Promise.all(
        (await readdir(directory, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
          .map(async (entry) => {
            const file = await safePath(options.root, `drafts/${entry.name}`);
            const info = await stat(file);
            return { file, modified: info.mtimeMs, size: info.size };
          }),
      )
    )
      .filter((entry) => entry.size <= 5 * 1024 * 1024)
      .sort((a, b) => b.modified - a.modified)
      .slice(0, 30);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of files) {
    try {
      const record = await readJson<Record<string, unknown>>(entry.file);
      if (record.incomplete !== true) continue;
      let checkpoint: AutomationCheckpoint;
      if (record.generation_resume) {
        checkpoint = checkpointSchema.parse(record.generation_resume);
        if (
          checkpoint.urs_sha256 !== hash(options.urs) ||
          checkpoint.base_sha256 !== hash(options.base) ||
          checkpoint.target_url !== new URL(options.target).href ||
          !isDeepStrictEqual(
            sortedHashes(checkpoint.context_hashes),
            sortedHashes(options.contextHashes),
          )
        )
          continue;
        const verified = replay(
          options.base,
          options.urs,
          checkpoint.proposals,
          options.contextHashes,
          options.target,
        );
        if (!isDeepStrictEqual(verified, checkpoint.checkpoint)) continue;
      } else {
        // Legacy records have no input fingerprint: require unchanged URS/candidate,
        // exact source hashes, an untouched input timestamp and a complete replay.
        if (
          entry.modified < options.inputsModifiedAt ||
          !isDeepStrictEqual(options.urs, options.previousUrs)
        )
          continue;
        const value = generatedPlanSchema.parse(record.value);
        if (
          !isDeepStrictEqual(
            sortedHashes(value.plan.context_hashes),
            sortedHashes(options.contextHashes),
          )
        )
          continue;
        const built = automationCheckpoint({
          base: options.base,
          urs: options.urs,
          target: options.target,
          contextHashes: options.contextHashes,
          diagnostics: record.diagnostics as ProviderOutputDiagnostic[],
        });
        if (!built || !isDeepStrictEqual(built.checkpoint, value)) continue;
        checkpoint = built;
      }
      const converted =
        options.base.plan.cases.filter((c) => c.manual).length -
        checkpoint.checkpoint.plan.cases.filter((c) => c.manual).length;
      if (converted > 0)
        return {
          file: path.relative(options.root, entry.file),
          value: checkpoint.checkpoint,
          checkpoint,
          converted,
        };
    } catch {
      /* An unrelated, stale, truncated, or edited record is not a resume point. */
    }
  }
}
