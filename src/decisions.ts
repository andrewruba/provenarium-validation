import type { ResolutionDecision, Urs } from './schema.js';
import { isDelegatedAnswer } from './urs-answers.js';
import { questionStatus } from './urs.js';

export interface AcceptedDecision {
  question_id: string;
  question: string;
  decision: string;
  authority: ResolutionDecision['authority'] | 'legacy';
  basis: ResolutionDecision['basis'] | 'legacy';
  rationale: string;
  citations: ResolutionDecision['citations'];
  original_answer?: string;
  targets: string[];
  requirement_ids: string[];
  applied_at: string;
}

/** Current accepted policy for downstream authoring. Stale answers and unaccepted
 * recommendations never become an authority merely by appearing in the YAML. */
export function acceptedDecisionLedger(urs: Urs): AcceptedDecision[] {
  return urs.open_questions.flatMap((question) => {
    if (questionStatus(urs, question) !== 'resolved' || isDelegatedAnswer(question.answer))
      return [];
    const resolution = question.resolution!;
    if (new Set(resolution.targets).size !== resolution.targets.length) return [];
    const provenance = resolution.decision;
    return [
      {
        question_id: question.id,
        question: question.question,
        decision: question.answer!.trim(),
        authority: provenance?.authority ?? 'legacy',
        basis: provenance?.basis ?? 'legacy',
        rationale:
          provenance?.rationale ??
          'Accepted resolution recorded before decision provenance was captured.',
        citations: structuredClone(provenance?.citations ?? []),
        ...(provenance?.original_answer ? { original_answer: provenance.original_answer } : {}),
        targets: [...resolution.targets],
        requirement_ids: resolution.targets
          .filter((target) => target.startsWith('requirement:'))
          .map((target) => target.slice('requirement:'.length)),
        applied_at: resolution.applied_at,
      },
    ];
  });
}
