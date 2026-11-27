import type { GeneratedPlanDocument } from './plan-edits.js';

/** A request-only view, never a runnable or publishable plan. The caller keeps the
 * full candidate and applies every scoped edit against that complete baseline. */
export function caseRequestView(candidate: GeneratedPlanDocument, caseIds: readonly string[]) {
  const selected = new Set(caseIds);
  if (!selected.size || selected.size !== caseIds.length)
    throw new Error('Request windows need a nonempty list of unique case IDs.');
  for (const id of selected)
    if (!candidate.plan.cases.some((item) => item.id === id))
      throw new Error(`Unknown request-window case ${id}.`);
  const view = structuredClone(candidate);
  view.plan.cases = view.plan.cases.filter((item) => selected.has(item.id));
  return {
    candidate: view,
    case_inventory: candidate.plan.cases.map((item) => ({
      id: item.id,
      title: item.title,
      classification: item.classification,
      requirements: [...item.requirements],
      manual: item.manual,
      ...(item.actor ? { actor: item.actor } : {}),
      steps: item.steps.map((step) => ({
        id: step.id,
        assertion_ids: step.assertions.map((assertion) => assertion.id),
        evidence_ids: step.evidence.map((evidence) => evidence.id),
      })),
    })),
    request_scope: {
      case_ids: [...caseIds],
      omitted_case_bodies: candidate.plan.cases.filter((item) => !selected.has(item.id)).length,
      instructions:
        'This is a request window, not a complete runnable plan. candidate contains the full selected case bodies and all plan-level obligations, questions, actors, declarations, and fixtures. case_inventory lists every case and its assertion/evidence IDs. All other case bodies remain unchanged in the full local baseline. Review only the selected cases; do not invent details of omitted cases. The caller validates and applies permitted edits against the complete original plan.',
    },
  };
}
