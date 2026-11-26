import { isDeepStrictEqual } from 'node:util';
import { stringify } from 'yaml';
import { z } from 'zod';
import { questionSchema, requirementSchema, ursSchema, type Urs } from './schema.js';
import { pendingAnsweredQuestions, questionAnswerHash, requirements } from './urs.js';

const questionIds = z.array(questionSchema.shape.id).min(1);
const reason = z.string().trim().min(1);
const editableDocumentSchema = ursSchema.shape.document.omit({ id: true, revision: true });
export const resolutionProposalSchema = z.strictObject({
  requirements: z.array(
    z.strictObject({
      question_ids: questionIds,
      value: requirementSchema,
      reason,
    }),
  ),
  document: z
    .strictObject({ question_ids: questionIds, value: editableDocumentSchema, reason })
    .optional(),
  unresolved: z.array(z.strictObject({ question_id: questionSchema.shape.id, reason })),
});
export type UrsResolutionProposal = z.infer<typeof resolutionProposalSchema>;

function resolutionTargets(proposal: UrsResolutionProposal): Map<string, Set<string>> {
  const targets = new Map<string, Set<string>>();
  const add = (ids: string[], target: string) => {
    for (const id of ids) {
      const current = targets.get(id) ?? new Set<string>();
      current.add(target);
      targets.set(id, current);
    }
  };
  for (const change of proposal.requirements)
    add(change.question_ids, `requirement:${change.value.id}`);
  if (proposal.document) add(proposal.document.question_ids, 'document');
  return targets;
}

/** A proposal can edit named existing requirements, never the question or answer records. */
export function validateResolutionProposal(urs: Urs, input: unknown): UrsResolutionProposal {
  const proposal = resolutionProposalSchema.parse(input);
  const pending = new Map(pendingAnsweredQuestions(urs).map((question) => [question.id, question]));
  if (new Set(urs.open_questions.map((question) => question.id)).size !== urs.open_questions.length)
    throw new Error('Resolve duplicate question IDs before applying answers.');
  const currentRequirements = requirements(urs);
  const requirementIds = new Set(currentRequirements.map((requirement) => requirement.id));
  if (requirementIds.size !== currentRequirements.length)
    throw new Error('Resolve duplicate requirement IDs before applying answers.');

  const validateQuestionIds = (ids: string[]) => {
    if (new Set(ids).size !== ids.length)
      throw new Error('A proposed change contains duplicate question IDs.');
    for (const id of ids)
      if (!pending.has(id))
        throw new Error(`Question ${id} is not an answered question awaiting review.`);
  };
  const changedRequirements = new Set<string>();
  for (const change of proposal.requirements) {
    validateQuestionIds(change.question_ids);
    if (!requirementIds.has(change.value.id))
      throw new Error(`Proposed requirement ${change.value.id} does not exist.`);
    if (changedRequirements.has(change.value.id))
      throw new Error(`Requirement ${change.value.id} has more than one proposed replacement.`);
    changedRequirements.add(change.value.id);
  }
  if (proposal.document) validateQuestionIds(proposal.document.question_ids);

  const targets = resolutionTargets(proposal);
  const unresolved = new Set<string>();
  for (const item of proposal.unresolved) {
    validateQuestionIds([item.question_id]);
    if (unresolved.has(item.question_id))
      throw new Error(`Question ${item.question_id} is listed as unresolved more than once.`);
    if (targets.has(item.question_id))
      throw new Error(`Question ${item.question_id} cannot be both resolved and unresolved.`);
    unresolved.add(item.question_id);
  }
  for (const question of pending.values()) {
    const appliedTargets = targets.get(question.id);
    if (!appliedTargets && !unresolved.has(question.id))
      throw new Error(`Proposal omits answered question ${question.id}.`);
    if (
      appliedTargets &&
      question.requirement &&
      !appliedTargets.has(`requirement:${question.requirement}`)
    )
      throw new Error(
        `Question ${question.id} must address its linked requirement ${question.requirement}.`,
      );
  }
  return proposal;
}

function nextRevision(revision: string): string {
  const trailing = revision.match(/\d+$/);
  if (!trailing) return `${revision}.1`;
  const incremented = (BigInt(trailing[0]) + 1n).toString().padStart(trailing[0].length, '0');
  return revision.slice(0, -trailing[0].length) + incremented;
}

/** Apply only a reviewed proposal and retain the original question and decision records. */
export function applyResolutionProposal(
  urs: Urs,
  input: unknown,
  timestamp = new Date().toISOString(),
): Urs {
  const proposal = validateResolutionProposal(urs, input);
  const next = structuredClone(urs);
  const replacements = new Map(
    proposal.requirements.map((change) => [change.value.id, change.value]),
  );
  for (const family of next.families)
    family.requirements = family.requirements.map((requirement) =>
      structuredClone(replacements.get(requirement.id) ?? requirement),
    );
  if (proposal.document)
    next.document = {
      ...structuredClone(proposal.document.value),
      id: urs.document.id,
      revision: urs.document.revision,
    };
  const targets = resolutionTargets(proposal);
  for (const question of next.open_questions) {
    const appliedTargets = targets.get(question.id);
    if (!appliedTargets) continue;
    question.resolution = {
      answer_hash: questionAnswerHash(question),
      applied_at: timestamp,
      targets: [...appliedTargets].sort(),
    };
  }
  if (targets.size) next.document.revision = nextRevision(urs.document.revision);
  return ursSchema.parse(next);
}

/** Render complete before/after text so acceptance covers all proposed edits. */
export function formatResolutionChanges(urs: Urs, input: unknown): string {
  const proposal = validateResolutionProposal(urs, input);
  const currentRequirements = new Map(
    requirements(urs).map((requirement) => [requirement.id, requirement]),
  );
  const targets = resolutionTargets(proposal);
  const output = ['Proposed requirement changes'];
  if (targets.size)
    output.push(
      `Document revision: ${urs.document.revision} → ${nextRevision(urs.document.revision)}`,
    );
  for (const question of pendingAnsweredQuestions(urs))
    output.push(
      `\n${question.id}${question.requirement ? ` → ${question.requirement}` : ''}\nQuestion: ${question.question}\nAnswer: ${question.answer!.trim()}`,
    );
  const show = (
    label: string,
    ids: string[],
    explanation: string,
    before: unknown,
    after: unknown,
  ) => {
    output.push(`\n${label} — ${ids.join(', ')}\n${explanation}`);
    if (isDeepStrictEqual(before, after))
      output.push(
        `No text change: the existing text already expresses this answer. Review to confirm.\nCurrent:\n${stringify(before, { lineWidth: 100 })}`,
      );
    else
      output.push(
        `Before:\n${stringify(before, { lineWidth: 100 })}After:\n${stringify(after, { lineWidth: 100 })}`,
      );
  };
  for (const change of proposal.requirements)
    show(
      change.value.id,
      change.question_ids,
      change.reason,
      currentRequirements.get(change.value.id),
      change.value,
    );
  if (proposal.document) {
    const { id: _id, revision: _revision, ...document } = urs.document;
    show(
      'Document purpose and scope',
      proposal.document.question_ids,
      proposal.document.reason,
      document,
      proposal.document.value,
    );
  }
  if (proposal.unresolved.length)
    output.push(
      `\nStill awaiting clarification:\n${proposal.unresolved.map((item) => `${item.question_id}: ${item.reason}`).join('\n')}`,
    );
  return output.join('\n');
}
