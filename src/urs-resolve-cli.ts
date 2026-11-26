import { select, text } from '@clack/prompts';
import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import type { AuthoringResult } from './authoring/index.js';
import { atomicWrite, exists, parseYaml, safePath, sha256, writeNew } from './files.js';
import { ursSchema, type Urs } from './schema.js';
import {
  pendingAnsweredQuestions,
  checkUrsStructure,
  questionStatus,
  unresolvedQuestions,
} from './urs.js';
import {
  applyResolutionProposal,
  formatResolutionChanges,
  resolutionProposalSchema,
  validateResolutionProposal,
  type UrsResolutionProposal,
} from './urs-resolution.js';
import { projectCommand } from './urs-setup.js';
import {
  isDelegatedAnswer,
  ursAnswerSuggestionsSchema,
  type UrsAnswerSuggestions,
} from './urs-answers.js';
import { citationSchema, questionSchema } from './schema.js';

const savedProposalV1Schema = z.strictObject({
  schema_version: z.literal(1),
  created_at: z.iso.datetime(),
  source: z.string(),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  proposal: resolutionProposalSchema,
});
const reviewedAnswerSchema = z.strictObject({
  question_id: questionSchema.shape.id,
  answer: z.string().trim().min(1),
  basis: z.enum(['documented', 'implementation', 'decision', 'human']),
  explanation: z.string(),
  citations: z.array(citationSchema),
});
type ReviewedAnswer = z.infer<typeof reviewedAnswerSchema>;
const savedRecommendationsSchema = savedProposalV1Schema.omit({ proposal: true }).extend({
  schema_version: z.literal(2),
  answers: z.array(reviewedAnswerSchema),
  deferred_question_ids: z.array(questionSchema.shape.id).default([]),
  recommendations: ursAnswerSuggestionsSchema,
});
const savedProposalSchema = z.union([
  savedProposalV1Schema,
  savedRecommendationsSchema.extend({
    proposal: resolutionProposalSchema,
  }),
]);

export interface ResolveUrsOptions {
  root: string;
  file: string;
  answersOnly?: boolean;
  apply?: string;
  resume?: string;
  url?: string;
  yes?: boolean;
  questions?: string[];
}
export interface ResolveUrsRuntime {
  isTTY?: boolean;
  text?: (options: { message: string; initialValue?: string }) => Promise<string | symbol>;
  confirm?: (options: { message: string; initialValue?: boolean }) => Promise<boolean | symbol>;
  select?: (options: {
    message: string;
    initialValue?: string;
    options: { value: string; label: string; hint?: string }[];
  }) => Promise<string | symbol>;
  log?: (message: string) => void;
  suggest?: (urs: Urs, questionIds: string[]) => Promise<AuthoringResult<UrsAnswerSuggestions>>;
  propose: (
    urs: Urs,
    recommendations?: UrsAnswerSuggestions,
  ) => Promise<AuthoringResult<UrsResolutionProposal>>;
}

/** Keep unrelated YAML comments and layout when recording answers or applying reviewed edits. */
export function updateYaml(raw: string, before: Urs, after: Urs): string {
  const document = parseDocument(raw);
  if (!isDeepStrictEqual(before.document, after.document))
    document.setIn(['document'], after.document);
  for (let family = 0; family < after.families.length; family++)
    for (let item = 0; item < after.families[family].requirements.length; item++) {
      const next = after.families[family].requirements[item];
      if (!isDeepStrictEqual(before.families[family].requirements[item], next))
        document.setIn(['families', family, 'requirements', item], next);
    }
  for (let index = 0; index < after.open_questions.length; index++) {
    const previous = before.open_questions[index];
    const question = after.open_questions[index];
    if (question.answer !== previous.answer)
      document.setIn(['open_questions', index, 'answer'], question.answer);
    if (!isDeepStrictEqual(previous.resolution, question.resolution)) {
      if (question.resolution)
        document.setIn(['open_questions', index, 'resolution'], question.resolution);
      else document.deleteIn(['open_questions', index, 'resolution']);
    }
  }
  return document.toString({ lineWidth: 100 });
}

export async function editableFile(root: string, input: string): Promise<string> {
  const relative = path.relative(root, path.resolve(root, input));
  const file = await safePath(root, relative);
  if (['packages', 'candidates', '.provenarium'].includes(relative.split(path.sep)[0]))
    throw new Error(
      'Resolve a working URS, not a generated candidate, approved package, or history file.',
    );
  let directory = await realpath(path.dirname(file));
  while (true) {
    if (path.basename(directory) === '.provenarium')
      throw new Error('Resolve the working URS, not a retained history file.');
    if (
      (await exists(path.join(directory, 'approval.json'))) ||
      (await exists(path.join(directory, 'candidate.json')))
    )
      throw new Error(
        'Copy the URS out of the candidate or approved package before resolving questions.',
      );
    const parent = path.dirname(directory);
    if (directory === parent) break;
    directory = parent;
  }
  return file;
}

export async function resolveUrsFile(
  options: ResolveUrsOptions,
  runtime: ResolveUrsRuntime,
): Promise<void> {
  if (options.answersOnly && options.apply)
    throw new Error('--answers-only cannot be combined with --apply.');
  if (options.apply && options.questions?.length)
    throw new Error('--question cannot be combined with --apply.');
  if (options.resume && (options.apply || options.answersOnly || options.questions?.length))
    throw new Error('--resume cannot be combined with --apply, --answers-only, or --question.');
  const root = path.resolve(options.root);
  const file = await editableFile(root, options.file);
  const log = runtime.log ?? console.log;
  const interactive = runtime.isTTY ?? !!process.stdin.isTTY;
  const ask = runtime.text ?? text;
  const choose = runtime.select ?? select;
  let raw = await readFile(file, 'utf8');
  let document = ursSchema.parse(parseYaml(raw));
  const artifact = async (name: string) => safePath(root, `.provenarium/resolutions/${name}`);
  const command = (args: string[] = []) =>
    projectCommand(root, ['urs', 'resolve', path.relative(root, file), ...args]);
  const assertCurrent = async () => {
    await editableFile(root, file);
    if ((await readFile(file, 'utf8')) !== raw)
      throw new Error(
        'The URS changed during review. No changes were applied; reopen the review against the current file.',
      );
  };
  const save = async (next: Urs, kind: string) => {
    await assertCurrent();
    const output = updateYaml(raw, document, next);
    const backup = await artifact(`${randomUUID()}.${kind}.before.yaml`);
    await writeNew(backup, raw);
    await assertCurrent();
    await atomicWrite(file, output);
    raw = output;
    document = next;
    return backup;
  };
  const summary = (nextStep?: string) => {
    const unresolved = unresolvedQuestions(document);
    log(
      `${document.open_questions.length - unresolved.length} resolved; ${pendingAnsweredQuestions(document).length} saved answers awaiting review; ${unresolved.filter((question) => questionStatus(document, question) === 'unanswered').length} unanswered.`,
    );
    log(
      nextStep ??
        (unresolved.length
          ? `Continue recommendations review: ${command()}`
          : `Generate the qualification protocol and tests: ${projectCommand(root, ['generate', '--urs', path.relative(root, file), '--url', options.url ?? '<app-url>'])}`),
    );
  };
  const selected = options.questions ?? [];
  if (selected.some((id) => !document.open_questions.some((question) => question.id === id)))
    throw new Error('Unknown question ID. Use an ID from this URS.');
  if (selected.length && (!interactive || options.yes))
    throw new Error(
      '--question needs an interactive terminal. Edit answer fields in YAML for scripted use.',
    );

  // Explicit offline answer entry remains available; generated recommendations never use it.
  if (options.answersOnly) {
    if (interactive && !options.yes) {
      const ids = document.open_questions
        .filter((question) =>
          selected.length
            ? selected.includes(question.id)
            : questionStatus(document, question) === 'unanswered',
        )
        .map((question) => question.id);
      for (const id of ids) {
        const question = document.open_questions.find((item) => item.id === id)!;
        log(`${id}: ${question.question}`);
        const answer = await ask({
          message: 'Your answer (Enter to keep it; Ctrl+C to save and stop)',
          initialValue: question.answer ?? undefined,
        });
        if (typeof answer === 'symbol') {
          log(`Stopped. Answers already entered are saved in ${file}.`);
          summary();
          return;
        }
        if (!answer.trim() || answer.trim() === question.answer?.trim()) continue;
        const next = structuredClone(document);
        next.open_questions.find((item) => item.id === id)!.answer = answer.trim();
        await save(next, 'answer');
        log(`Saved answer for ${id}.`);
      }
    }
    summary(`Review these answers and their requirement changes: ${command()}`);
    return;
  }
  const structuralErrors = await checkUrsStructure(document, root);
  if (structuralErrors.length)
    throw new Error(
      `This working URS has structural issues that must be corrected before AI resolution. For generated source-reference formatting issues, run ${projectCommand(root, ['urs', 'check', path.relative(root, file), '--fix-references'])}.\n${structuralErrors.join('\n')}`,
    );

  let staged = structuredClone(document);
  let recommendations: UrsAnswerSuggestions = { suggestions: [] };
  const answers = new Map<string, ReviewedAnswer>();
  const deferred = new Set<string>();
  const applyAnswers = (records: ReviewedAnswer[]) => {
    const ids = new Set<string>();
    for (const record of records) {
      if (ids.has(record.question_id)) throw new Error('Saved review repeats an answer ID.');
      ids.add(record.question_id);
      const question = staged.open_questions.find((item) => item.id === record.question_id);
      if (!question)
        throw new Error(`Saved review addresses unknown question ${record.question_id}.`);
      question.answer = record.answer;
      answers.set(record.question_id, record);
      deferred.delete(record.question_id);
    }
  };
  const humanAnswer = (id: string, answer: string): ReviewedAnswer => ({
    question_id: id,
    answer,
    basis: 'human',
    explanation: 'Your recorded answer.',
    citations: [],
  });
  for (const question of staged.open_questions)
    if (
      (questionStatus(staged, question) !== 'resolved' || selected.includes(question.id)) &&
      question.answer?.trim()
    )
      answers.set(question.id, humanAnswer(question.id, question.answer.trim()));

  let proposal: UrsResolutionProposal = { requirements: [], unresolved: [] };
  let reviewFile: string | undefined;
  let diffFile: string | undefined;
  const source = () => ({ source: file, source_sha256: sha256(raw) });
  const reviewedDocument = () => {
    const next = applyResolutionProposal(staged, proposal);
    const resolvedIds = new Set([
      ...proposal.requirements.flatMap((change) => change.question_ids),
      ...(proposal.document?.question_ids ?? []),
    ]);
    // Accept ready changes never silently accepts a recommendation still awaiting evidence.
    next.open_questions = next.open_questions.map((question) =>
      resolvedIds.has(question.id)
        ? question
        : structuredClone(document.open_questions.find((item) => item.id === question.id)!),
    );
    return next;
  };
  const stagedRecommendations = (): UrsAnswerSuggestions => ({
    suggestions: recommendations.suggestions.filter(
      (item) => answers.get(item.question_id)?.basis !== 'human',
    ),
  });
  const persistUnapproved = async (pendingIds?: Set<string>) => {
    await assertCurrent();
    const draftFile = await artifact(`${randomUUID()}.recommendations.json`);
    await writeNew(
      draftFile,
      JSON.stringify(
        {
          schema_version: 2,
          created_at: new Date().toISOString(),
          ...source(),
          answers: [...answers.values()].filter(
            (item) => !pendingIds || pendingIds.has(item.question_id),
          ),
          deferred_question_ids: [...deferred].filter((id) => !pendingIds || pendingIds.has(id)),
          recommendations: {
            suggestions: recommendations.suggestions.filter(
              (item) => !pendingIds || pendingIds.has(item.question_id),
            ),
          },
        },
        null,
        2,
      ) + '\n',
    );
    return draftFile;
  };
  const fullReview = () =>
    formatResolutionChanges(staged, proposal) +
    '\n\nComplete proposed requirements\n' +
    stringify(reviewedDocument(), { lineWidth: 100 });
  const persistReview = async () => {
    await assertCurrent();
    const id = randomUUID();
    reviewFile = await artifact(`${id}.proposal.json`);
    diffFile = await artifact(`${id}.diff.txt`);
    await writeNew(
      reviewFile,
      JSON.stringify(
        {
          schema_version: 2,
          created_at: new Date().toISOString(),
          ...source(),
          answers: [...answers.values()],
          deferred_question_ids: [...deferred],
          recommendations,
          proposal,
        },
        null,
        2,
      ) + '\n',
    );
    await writeNew(diffFile, fullReview() + '\n');
  };
  const prepareProposal = async (): Promise<boolean> => {
    await assertCurrent();
    try {
      if (!pendingAnsweredQuestions(staged).length) {
        proposal = { requirements: [], unresolved: [] };
      } else {
        log('Preparing recommendations and requirement changes for one review.');
        const result = await runtime.propose(structuredClone(staged), stagedRecommendations());
        await assertCurrent();
        if (!result.value || result.incomplete) {
          const draft = await persistUnapproved();
          log(
            `A reviewable proposal could not be prepared. Your working requirements are unchanged. Unapproved answers and recommendations are retained: ${draft}`,
          );
          summary(
            `Resume retained recommendations: ${command(['--resume', path.relative(root, draft)])}`,
          );
          return false;
        }
        proposal = validateResolutionProposal(staged, result.value);
      }
      const errors = await checkUrsStructure(reviewedDocument(), root);
      if (errors.length)
        throw new Error(
          `The proposed requirements failed structural validation; no changes were applied.\n${errors.join('\n')}`,
        );
    } catch (error) {
      // The original hash must still match before retaining a resumable draft.
      await assertCurrent();
      const draft = await persistUnapproved();
      log(
        `The proposal could not be completed. Unapproved answers and edits are retained: ${draft}`,
      );
      summary(
        `Resume retained recommendations: ${command(['--resume', path.relative(root, draft)])}`,
      );
      throw error;
    }
    await persistReview();
    return true;
  };
  const restoreRecommendations = (saved: z.infer<typeof savedRecommendationsSchema>) => {
    recommendations = saved.recommendations;
    const recommendationIds = new Set<string>();
    for (const suggestion of recommendations.suggestions) {
      if (
        recommendationIds.has(suggestion.question_id) ||
        !staged.open_questions.some((question) => question.id === suggestion.question_id)
      )
        throw new Error('Saved recommendations contain an unknown or repeated question ID.');
      recommendationIds.add(suggestion.question_id);
    }
    for (const id of saved.deferred_question_ids) {
      const question = staged.open_questions.find((item) => item.id === id);
      if (!question || !isDelegatedAnswer(question.answer))
        throw new Error('Saved review can defer only an existing delegated answer.');
      question.answer = null;
      answers.delete(id);
      deferred.add(id);
    }
    applyAnswers(saved.answers);
  };
  if (options.apply) {
    const saved = savedProposalSchema.parse(
      JSON.parse(await readFile(path.resolve(root, options.apply), 'utf8')),
    );
    if (saved.source !== file || saved.source_sha256 !== sha256(raw))
      throw new Error(
        'This proposal does not match the current URS. Reopen recommendations review against the current file.',
      );
    if (saved.schema_version === 2) {
      restoreRecommendations(saved);
    }
    proposal = validateResolutionProposal(staged, saved.proposal);
    reviewFile = path.resolve(root, options.apply);
    const errors = await checkUrsStructure(applyResolutionProposal(staged, proposal), root);
    if (errors.length)
      throw new Error(
        `The proposed requirements failed structural validation; no changes were applied.\n${errors.join('\n')}`,
      );
  } else if (options.resume) {
    const saved = savedRecommendationsSchema.parse(
      JSON.parse(await readFile(path.resolve(root, options.resume), 'utf8')),
    );
    if (saved.source !== file || saved.source_sha256 !== sha256(raw))
      throw new Error('Saved recommendations were created for a different URS or revision.');
    restoreRecommendations(saved);
    if (!(await prepareProposal())) return;
  } else {
    const reviewIds = selected.length
      ? selected
      : unresolvedQuestions(staged).map((question) => question.id);
    if (!reviewIds.length) {
      log('All retained questions are resolved.');
      summary();
      return;
    }
    const recommendationIds = reviewIds.filter((id) => {
      const question = staged.open_questions.find((item) => item.id === id)!;
      return (
        selected.includes(id) || !question.answer?.trim() || isDelegatedAnswer(question.answer)
      );
    });
    for (const id of recommendationIds) {
      const question = staged.open_questions.find((item) => item.id === id)!;
      if (isDelegatedAnswer(question.answer)) {
        question.answer = null;
        answers.delete(id);
        deferred.add(id);
      }
    }
    if (recommendationIds.length && runtime.suggest) {
      const result = await runtime.suggest(structuredClone(document), recommendationIds);
      await assertCurrent();
      if (!result.value || result.incomplete) {
        log(
          'Recommendations could not be prepared. Your working requirements and saved answers are unchanged.',
        );
        summary(`Resume recommendations review: ${command()}`);
        return;
      }
      recommendations = result.value;
      const supplied = new Set<string>();
      for (const suggestion of recommendations.suggestions) {
        if (
          !recommendationIds.includes(suggestion.question_id) ||
          supplied.has(suggestion.question_id)
        )
          throw new Error('Recommendations contain an unselected or duplicate question ID.');
        supplied.add(suggestion.question_id);
        if (suggestion.answer?.trim())
          applyAnswers([
            {
              question_id: suggestion.question_id,
              answer: suggestion.answer.trim(),
              basis: suggestion.basis,
              explanation: suggestion.explanation,
              citations: suggestion.citations,
            },
          ]);
      }
      if (supplied.size !== recommendationIds.length)
        throw new Error('Recommendations omit selected questions.');
    }
    if (!(await prepareProposal())) return;
  }

  const compact = (value: string, length = 240) =>
    value.length <= length ? value : value.slice(0, length - 1) + '…';
  const reviewCounts = () => {
    const ready = new Set([
      ...proposal.requirements.flatMap((change) => change.question_ids),
      ...(proposal.document?.question_ids ?? []),
    ]);
    return {
      ready: ready.size,
      pending: unresolvedQuestions(staged).filter((question) => !ready.has(question.id)).length,
    };
  };
  const showReview = () => {
    log(
      `Requirements review: ${document.document.title}\n${compact(document.document.intended_use)}`,
    );
    const counts = reviewCounts();
    log(`${counts.ready} ready to accept; ${counts.pending} pending.`);
    const visible = new Set([
      ...unresolvedQuestions(staged).map((question) => question.id),
      ...answers.keys(),
      ...recommendations.suggestions.map((item) => item.question_id),
    ]);
    for (const id of visible) {
      const record = answers.get(id);
      const suggestion = recommendations.suggestions.find((item) => item.question_id === id);
      const question = staged.open_questions.find((item) => item.id === id)!;
      const basis = record
        ? {
            documented: 'Documented behavior',
            implementation: 'Observed implementation',
            decision: 'Proposed default',
            human: 'Your saved answer',
          }[record.basis]
        : 'Needs specific evidence';
      log(
        `${id} · ${basis}\n${record?.answer ?? suggestion?.explanation ?? question.question}${record?.explanation ? `\n${compact(record.explanation)}` : ''}${record?.citations.length ? `\nSources: ${record.citations.map((citation) => `${citation.source}: ${citation.location}`).join('; ')}` : ''}`,
      );
    }
    if (proposal.requirements.length)
      log(
        `Requirement changes:\n${proposal.requirements.map((change) => `  ${change.value.id} — ${change.value.title}: ${compact(change.reason)}`).join('\n')}`,
      );
    if (proposal.document) log(`Purpose and scope: ${compact(proposal.document.reason)}`);
    if (proposal.unresolved.length)
      log(
        `Still pending:\n${proposal.unresolved.map((item) => `  ${item.question_id}: ${item.reason}`).join('\n')}`,
      );
    if (diffFile) log(`Complete before/after review: ${diffFile}`);
  };
  const apply = async () => {
    await assertCurrent();
    const next = reviewedDocument();
    const errors = await checkUrsStructure(next, root);
    if (errors.length)
      throw new Error(
        `The proposed requirements failed structural validation; no changes were applied.\n${errors.join('\n')}`,
      );
    const backup = await save(next, 'requirements');
    await writeNew(backup.replace(/\.before\.yaml$/, '.after.yaml'), raw);
    log(
      `Applied reviewed recommendations and requirement changes to ${file}. Previous version: ${backup}`,
    );
    const pendingIds = new Set(unresolvedQuestions(document).map((question) => question.id));
    if (pendingIds.size) {
      const continuation = await persistUnapproved(pendingIds);
      log(`Pending recommendations and edits remain unapproved and are retained: ${continuation}`);
      summary(
        `Resume pending recommendations: ${command(['--resume', path.relative(root, continuation)])}`,
      );
    } else summary();
  };
  const saveForLater = () => {
    log('Review saved for later. Your working requirements and saved answers are unchanged.');
    summary(
      `Review this saved proposal without another AI call: ${command(['--apply', path.relative(root, reviewFile!)])}`,
    );
  };
  let edits = 0;
  while (true) {
    showReview();
    const hasChanges = proposal.requirements.length > 0 || Boolean(proposal.document);
    if (options.apply && options.yes) {
      if (hasChanges) await apply();
      else summary();
      return;
    }
    if (!interactive || options.yes) {
      saveForLater();
      return;
    }
    const action = await choose({
      message: 'Review recommendations and requirement changes',
      initialValue: hasChanges ? 'accept' : options.apply || edits >= 2 ? 'details' : 'edit',
      options: [
        ...(hasChanges
          ? [
              {
                value: 'accept',
                label: reviewCounts().pending
                  ? 'Accept ready recommendations and changes'
                  : 'Accept recommendations and changes',
              },
            ]
          : []),
        ...(!options.apply && edits < 2 ? [{ value: 'edit', label: 'Edit selected items' }] : []),
        { value: 'details', label: 'View full changes' },
        { value: 'later', label: 'Save for later' },
      ],
    });
    if (typeof action === 'symbol' || action === 'later') {
      saveForLater();
      return;
    }
    if (action === 'details') {
      log(fullReview());
      continue;
    }
    if (action === 'accept' && hasChanges) {
      await apply();
      return;
    }
    if (action !== 'edit' || options.apply || edits >= 2)
      throw new Error('Unknown review selection.');
    let changed = false;
    while (true) {
      const editable = staged.open_questions.filter(
        (question) =>
          questionStatus(
            document,
            document.open_questions.find((item) => item.id === question.id)!,
          ) !== 'resolved' || selected.includes(question.id),
      );
      const selectedId = await choose({
        message: 'Choose an item to edit; finish editing to update the review',
        initialValue: 'done',
        options: [
          ...editable.map((question) => ({
            value: question.id,
            label: `${question.id}: ${compact(question.question, 100)}`,
          })),
          { value: 'done', label: 'Done editing' },
        ],
      });
      if (typeof selectedId === 'symbol') {
        const draft = await persistUnapproved();
        log(`Stopped. Working requirements are unchanged; unapproved edits are retained: ${draft}`);
        summary(`Resume retained edits: ${command(['--resume', path.relative(root, draft)])}`);
        return;
      }
      if (selectedId === 'done') break;
      const question = editable.find((item) => item.id === selectedId);
      if (!question) throw new Error('Unknown review item.');
      const proposed = answers.get(question.id)?.answer ?? question.answer ?? '';
      const edited = await ask({
        message: `${question.id}: Edit the proposed answer`,
        initialValue: proposed,
      });
      if (typeof edited === 'symbol') {
        const draft = await persistUnapproved();
        log(`Stopped. Working requirements are unchanged; unapproved edits are retained: ${draft}`);
        summary(`Resume retained edits: ${command(['--resume', path.relative(root, draft)])}`);
        return;
      }
      if (!edited.trim() || edited.trim() === proposed.trim()) continue;
      applyAnswers([
        { ...humanAnswer(question.id, edited.trim()), explanation: 'Edited in this review.' },
      ]);
      changed = true;
    }
    if (!changed) continue;
    edits++;
    if (!(await prepareProposal())) return;
  }
}
