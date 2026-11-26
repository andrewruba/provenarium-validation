import { z } from 'zod';
import type { ContextBundle } from './context.js';
import { citationSchema, questionSchema, type Urs } from './schema.js';
import { questionStatus, requirements } from './urs.js';

export const ursAnswerSuggestionSchema = z.strictObject({
  question_id: questionSchema.shape.id,
  answer: z.string().trim().min(1).nullable(),
  basis: z.enum(['documented', 'implementation', 'decision']),
  explanation: z.string().trim().min(1),
  citations: z.array(citationSchema),
  choices: z.array(z.string().trim().min(1)).max(4),
});
export const ursAnswerSuggestionsSchema = z.strictObject({
  suggestions: z.array(ursAnswerSuggestionSchema),
});
export type UrsAnswerSuggestion = z.infer<typeof ursAnswerSuggestionSchema>;
export type UrsAnswerSuggestions = z.infer<typeof ursAnswerSuggestionsSchema>;
export type UrsAnswerEvidence = {
  context: ContextBundle;
  observation?: { url: string };
};

/** Already recorded answers are revisited only when their IDs are explicitly selected. */
export function answerSuggestionQuestions(urs: Urs, questionIds?: string[]) {
  const questions = new Map(urs.open_questions.map((question) => [question.id, question]));
  if (questions.size !== urs.open_questions.length)
    throw new Error('Resolve duplicate question IDs before suggesting answers.');
  if (questionIds) {
    if (new Set(questionIds).size !== questionIds.length)
      throw new Error('Question selection contains duplicate IDs.');
    return questionIds.map((id) => {
      const question = questions.get(id);
      if (!question) throw new Error(`Unknown question ${id}.`);
      return question;
    });
  }
  return urs.open_questions.filter((question) => questionStatus(urs, question) === 'unanswered');
}

/** Evidence names must be supplied material, never citations invented by the model. */
export function validateUrsAnswerSuggestions(
  urs: Urs,
  input: unknown,
  evidence: UrsAnswerEvidence,
  questionIds?: string[],
): UrsAnswerSuggestions {
  const suggestions = ursAnswerSuggestionsSchema.parse(input);
  const selected = new Set(
    answerSuggestionQuestions(urs, questionIds).map((question) => question.id),
  );
  const seen = new Set<string>();
  const citations = new Set(
    evidence.context.passages.map((passage) => JSON.stringify([passage.source, passage.location])),
  );
  citations.add(JSON.stringify(['@urs', 'document']));
  for (const requirement of requirements(urs))
    citations.add(JSON.stringify(['@urs', `requirement:${requirement.id}`]));
  for (const question of urs.open_questions)
    citations.add(JSON.stringify(['@urs', `question:${question.id}`]));
  if (evidence.observation)
    citations.add(JSON.stringify(['@application', evidence.observation.url]));
  for (const suggestion of suggestions.suggestions) {
    if (!selected.has(suggestion.question_id))
      throw new Error(`Suggestion addresses unselected question ${suggestion.question_id}.`);
    if (seen.has(suggestion.question_id))
      throw new Error(`More than one suggestion addresses ${suggestion.question_id}.`);
    seen.add(suggestion.question_id);
    if (suggestion.basis === 'decision' && suggestion.answer !== null)
      throw new Error(
        `Question ${suggestion.question_id} needs a human decision, not a default answer.`,
      );
    if (suggestion.basis !== 'decision' && (!suggestion.answer || !suggestion.citations.length))
      throw new Error(`Suggested answer for ${suggestion.question_id} needs supporting evidence.`);
    if (new Set(suggestion.choices).size !== suggestion.choices.length)
      throw new Error(`Question ${suggestion.question_id} contains duplicate answer choices.`);
    for (const citation of suggestion.citations)
      if (!citations.has(JSON.stringify([citation.source, citation.location])))
        throw new Error(
          `Question ${suggestion.question_id} cites material that was not supplied: ${citation.source}: ${citation.location}.`,
        );
  }
  for (const id of selected)
    if (!seen.has(id)) throw new Error(`Suggestions omit selected question ${id}.`);
  return suggestions;
}
