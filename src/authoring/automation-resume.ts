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
type AutomationResumeOptions = {
  root: string;
  base: GeneratedPlan;
  urs: Urs;
  previousUrs: Urs;
  target: string;
  contextHashes: ContextHash[];
  inputsModifiedAt: number;
};
const maxRecordBytes = 5 * 1024 * 1024;
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

async function verifySavedResume(
  options: AutomationResumeOptions,
  entry: { file: string; modified: number },
): Promise<AutomationResume> {
  const record = await readJson<Record<string, unknown>>(entry.file);
  if (record?.incomplete !== true) throw new Error('Expected an incomplete authoring record.');
  let checkpoint: AutomationCheckpoint;
  let value: GeneratedPlan;
  if (record.generation_resume !== undefined) {
    const parsed = checkpointSchema.safeParse(record.generation_resume);
    if (!parsed.success) throw new Error('The saved conversion checkpoint has an invalid format.');
    checkpoint = parsed.data;
    if (
      checkpoint.urs_sha256 !== hash(options.urs) ||
      checkpoint.base_sha256 !== hash(options.base) ||
      checkpoint.target_url !== new URL(options.target).href ||
      !isDeepStrictEqual(
        sortedHashes(checkpoint.context_hashes),
        sortedHashes(options.contextHashes),
      )
    )
      throw new Error(
        'The saved conversions do not match the current candidate, URS, target, or context.',
      );
    value = replay(
      options.base,
      options.urs,
      checkpoint.proposals,
      options.contextHashes,
      options.target,
    );
    if (!isDeepStrictEqual(value, checkpoint.checkpoint))
      throw new Error('Replayed conversions differ from the saved checkpoint.');
  } else {
    // Legacy records have no input fingerprint: require unchanged URS/candidate,
    // exact source hashes, an untouched input timestamp and a complete replay.
    if (
      entry.modified < options.inputsModifiedAt ||
      !isDeepStrictEqual(options.urs, options.previousUrs)
    )
      throw new Error('The candidate or URS changed after this authoring record was saved.');
    const saved = generatedPlanSchema.safeParse(record.value);
    if (!saved.success || !Array.isArray(record.diagnostics))
      throw new Error('The authoring record does not contain replayable conversions.');
    if (
      !isDeepStrictEqual(
        sortedHashes(saved.data.plan.context_hashes),
        sortedHashes(options.contextHashes),
      )
    )
      throw new Error('The saved conversions do not match the current context.');
    const built = automationCheckpoint({
      base: options.base,
      urs: options.urs,
      target: options.target,
      contextHashes: options.contextHashes,
      diagnostics: record.diagnostics as ProviderOutputDiagnostic[],
    });
    if (!built || !isDeepStrictEqual(built.checkpoint, saved.data))
      throw new Error('The saved conversions could not be replayed against the current candidate.');
    checkpoint = built;
    value = built.checkpoint;
  }
  const converted =
    options.base.plan.cases.filter((c) => c.manual).length -
    value.plan.cases.filter((c) => c.manual).length;
  if (converted <= 0) throw new Error('The record does not contain completed case conversions.');
  return { file: path.relative(options.root, entry.file), value, checkpoint, converted };
}

/** Load a specific saved conversion checkpoint for offline candidate generation. */
export async function loadAutomationResume(
  options: AutomationResumeOptions & { file: string },
): Promise<AutomationResume> {
  if (!options.file.startsWith('drafts/') || !options.file.endsWith('.json'))
    throw new Error('--resume requires a project-relative JSON authoring record inside drafts/.');
  const file = await safePath(options.root, options.file);
  const info = await stat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new Error(`Authoring record not found: ${options.file}`);
    throw error;
  });
  if (!info.isFile() || info.size > maxRecordBytes)
    throw new Error('The authoring record must be a regular JSON file of at most 5 MiB.');
  const resumed = await verifySavedResume(options, { file, modified: info.mtimeMs });
  const remaining = resumed.value.plan.cases.filter((c) => c.manual).map((c) => c.id);
  if (remaining.length)
    throw new Error(
      `Offline resume requires completed conversions. Manual cases remain: ${remaining.join(', ')}.`,
    );
  return resumed;
}

/** Resume only replayable conversions against the unchanged current candidate and inputs.
 * Retained drafts remain unapproved; this never replaces an approved package. */
export async function findAutomationResume(
  options: AutomationResumeOptions,
): Promise<AutomationResume | undefined> {
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
      .filter((entry) => entry.size <= maxRecordBytes)
      .sort((a, b) => b.modified - a.modified)
      .slice(0, 30);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of files) {
    try {
      return await verifySavedResume(options, entry);
    } catch {
      /* An unrelated, stale, truncated, or edited record is not a resume point. */
    }
  }
}
