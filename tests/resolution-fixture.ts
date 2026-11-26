import type { UrsResolutionProposal } from '../src/urs-resolution.js';

/** Express a legacy saved proposal through the provider's exclusive question outcomes. */
export function resolutionProviderValue(proposal: UrsResolutionProposal) {
  const questions: Record<
    string,
    | { status: 'resolved'; requirement_ids: string[]; document: boolean }
    | { status: 'clarification'; reason: string }
  > = {};
  const resolved = (id: string) => {
    const result = (questions[id] ??= { status: 'resolved', requirement_ids: [], document: false });
    if (result.status !== 'resolved')
      throw new Error('Fixture has contradictory question outcomes.');
    return result;
  };
  for (const change of proposal.requirements)
    for (const id of change.question_ids) resolved(id).requirement_ids.push(change.value.id);
  if (proposal.document)
    for (const id of proposal.document.question_ids) resolved(id).document = true;
  for (const item of proposal.unresolved) {
    if (questions[item.question_id])
      throw new Error('Fixture has contradictory question outcomes.');
    questions[item.question_id] = { status: 'clarification', reason: item.reason };
  }
  return {
    requirements: proposal.requirements.map(({ value, reason }) => ({ value, reason })),
    ...(proposal.document
      ? { document: { value: proposal.document.value, reason: proposal.document.reason } }
      : {}),
    questions,
  };
}
