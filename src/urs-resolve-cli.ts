import { confirm, select, text } from '@clack/prompts';
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
  requirements,
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
import type { UrsAnswerSuggestions } from './urs-answers.js';

const savedProposalSchema = z.strictObject({
  schema_version: z.literal(1),
  created_at: z.iso.datetime(),
  source: z.string(),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  proposal: resolutionProposalSchema,
});

export interface ResolveUrsOptions {
  root: string;
  file: string;
  answersOnly?: boolean;
  apply?: string;
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
  propose: (urs: Urs) => Promise<AuthoringResult<UrsResolutionProposal>>;
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
  const root = path.resolve(options.root);
  const file = await editableFile(root, options.file);
  const log = runtime.log ?? console.log;
  const interactive = runtime.isTTY ?? !!process.stdin.isTTY;
  const ask = runtime.text ?? text;
  const accept = runtime.confirm ?? confirm;
  const choose = runtime.select ?? select;
  let raw = await readFile(file, 'utf8');
  let document = ursSchema.parse(parseYaml(raw));
  const artifact = async (name: string) => safePath(root, `.provenarium/resolutions/${name}`);
  const assertCurrent = async () => {
    await editableFile(root, file);
    if ((await readFile(file, 'utf8')) !== raw)
      throw new Error(
        'The URS changed during resolution. No changes were applied; rerun resolve against the current file.',
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
  const summary = () => {
    const unresolved = unresolvedQuestions(document);
    log(
      `${document.open_questions.length - unresolved.length} resolved; ${pendingAnsweredQuestions(document).length} answered awaiting review; ${unresolved.filter((question) => questionStatus(document, question) === 'unanswered').length} unanswered.`,
    );
    log(`Check requirements: ${projectCommand(root, ['urs', 'check', path.relative(root, file)])}`);
  };
  const reviewAndApply = async (proposal: UrsResolutionProposal, allowYes: boolean) => {
    log(formatResolutionChanges(document, proposal));
    if (!proposal.requirements.length && !proposal.document) {
      log(
        'No requirement changes can be applied yet. Clarify the pending answers and rerun resolve.',
      );
      return false;
    }
    let accepted = allowYes && options.yes;
    if (!accepted && interactive)
      accepted =
        (await accept({
          message: 'Apply these reviewed requirement changes and retain the questions and answers?',
          initialValue: false,
        })) === true;
    if (!accepted) {
      log('Requirement changes were not applied. Recorded answers are saved for your next review.');
      return false;
    }
    await assertCurrent();
    const next = applyResolutionProposal(document, proposal);
    const structuralErrors = await checkUrsStructure(next, root);
    if (structuralErrors.length)
      throw new Error(
        `The proposed requirements failed structural validation; no changes were applied.\n${structuralErrors.join('\n')}`,
      );
    const backup = await save(next, 'requirements');
    const after = backup.replace(/\.before\.yaml$/, '.after.yaml');
    await writeNew(after, raw);
    log(`Applied reviewed changes to ${file}. Previous version: ${backup}`);
    return true;
  };

  if (options.apply) {
    const saved = savedProposalSchema.parse(
      JSON.parse(await readFile(path.resolve(root, options.apply), 'utf8')),
    );
    if (saved.source !== file || saved.source_sha256 !== sha256(raw))
      throw new Error(
        'This proposal does not match the current URS. Rerun resolve to review fresh changes.',
      );
    const proposal = validateResolutionProposal(document, saved.proposal);
    await reviewAndApply(proposal, true);
    summary();
    return;
  }

  const selected = options.questions;
  if (selected?.some((id) => !document.open_questions.some((question) => question.id === id)))
    throw new Error('Unknown question ID. Use an ID from this URS.');
  if (selected?.length && (!interactive || options.yes))
    throw new Error(
      '--question needs an interactive terminal. Edit answer fields in YAML for scripted use.',
    );
  if (!options.answersOnly) {
    const structuralErrors = await checkUrsStructure(document, root);
    if (structuralErrors.length)
      throw new Error(
        `This working URS has structural issues that must be corrected before AI resolution. For generated source-reference formatting issues, run ${projectCommand(root, ['urs', 'check', path.relative(root, file), '--fix-references'])}.\n${structuralErrors.join('\n')}`,
      );
  }
  // Add visible answer slots to older drafts without changing their questions or requirements.
  const withSlots = structuredClone(document);
  for (const question of withSlots.open_questions) question.answer ??= null;
  if (!isDeepStrictEqual(document, withSlots)) await save(withSlots, 'answer-slots');

  if (interactive && !options.yes) {
    const ids = document.open_questions
      .filter((question) =>
        selected?.length
          ? selected.includes(question.id)
          : questionStatus(document, question) === 'unanswered',
      )
      .map((question) => question.id);
    let suggestions: UrsAnswerSuggestions['suggestions'] = [];
    if (ids.length && !options.answersOnly && runtime.suggest) {
      const result = await runtime.suggest(document, ids);
      await assertCurrent();
      if (result.value && !result.incomplete) {
        suggestions = result.value.suggestions;
        const suggestionFile = await artifact(`${randomUUID()}.suggestions.json`);
        await writeNew(
          suggestionFile,
          JSON.stringify(
            {
              source: file,
              source_sha256: sha256(raw),
              created_at: new Date().toISOString(),
              ...result.value,
            },
            null,
            2,
          ) + '\n',
        );
        log(`Suggested answers saved for review: ${suggestionFile}`);
      } else {
        log(
          'Suggested answers are unavailable. You can enter your own answers or skip; no suggestions have been accepted.',
        );
      }
    }
    for (const id of ids) {
      const question = document.open_questions.find((item) => item.id === id)!;
      const requirement = requirements(document).find((item) => item.id === question.requirement);
      log(
        `${id}: ${question.question}\n${requirement ? `Related requirement:\n${stringify(requirement)}` : `Document context:\n${stringify(document.document)}`}`,
      );
      const suggestion = suggestions.find((item) => item.question_id === id);
      let answer: string | symbol;
      if (suggestion) {
        if (question.answer?.trim()) log(`Current answer: ${question.answer}`);
        const basis = {
          documented: 'Supported by documented requirements',
          implementation: 'Observed implementation; confirm this is intended',
          decision: 'Product decision needed',
        }[suggestion.basis];
        log(`${basis}\n${suggestion.explanation}`);
        if (suggestion.answer) log(`Suggested answer: ${suggestion.answer}`);
        if (suggestion.citations.length)
          log(
            `Sources:\n${suggestion.citations.map((citation) => `  ${citation.source}: ${citation.location}`).join('\n')}`,
          );
        const choices = [
          ...(suggestion.answer ? [{ value: 'accept', label: 'Accept suggested answer' }] : []),
          { value: 'edit', label: suggestion.answer ? 'Edit answer' : 'Write an answer' },
          ...suggestion.choices.map((choice, index) => ({
            value: `choice:${index}`,
            label: choice,
          })),
          {
            value: 'skip',
            label: question.answer?.trim() ? 'Keep current answer' : 'Skip for now',
          },
        ];
        const selectedAnswer = await choose({
          message: `Answer ${id}`,
          initialValue: suggestion.answer && !question.answer?.trim() ? 'accept' : 'skip',
          options: choices,
        });
        if (typeof selectedAnswer === 'symbol') answer = selectedAnswer;
        else if (selectedAnswer === 'skip') continue;
        else if (selectedAnswer === 'accept' && suggestion.answer) answer = suggestion.answer;
        else if (
          selectedAnswer.startsWith('choice:') &&
          suggestion.choices[Number(selectedAnswer.slice(7))]
        )
          answer = suggestion.choices[Number(selectedAnswer.slice(7))];
        else if (selectedAnswer === 'edit')
          answer = await ask({
            message: 'Edit your answer (Enter on an empty answer to skip)',
            initialValue: question.answer?.trim() || suggestion.answer || undefined,
          });
        else throw new Error('Unknown suggested-answer selection.');
      } else {
        answer = await ask({
          message: 'Your answer (Enter to skip; Ctrl+C to save and stop)',
          initialValue: question.answer ?? undefined,
        });
      }
      if (typeof answer === 'symbol') {
        log(`Stopped. Answers already entered are saved in ${file}.`);
        summary();
        return;
      }
      if (!answer.trim()) continue;
      const next = structuredClone(document);
      next.open_questions.find((item) => item.id === id)!.answer = answer.trim();
      await save(next, 'answer');
      log(`Saved answer for ${id}.`);
    }
  }
  if (options.answersOnly) {
    log(`Answers saved in ${file}. Run urs resolve again to review their requirement changes.`);
    summary();
    return;
  }
  if (!pendingAnsweredQuestions(document).length) {
    log(
      unresolvedQuestions(document).length
        ? 'Answer the remaining questions in YAML or rerun resolve in an interactive terminal.'
        : 'All retained questions are resolved.',
    );
    summary();
    return;
  }
  const result = await runtime.propose(document);
  if (!result.value || result.incomplete) {
    log(
      'No requirement changes were applied. Your answers are saved; retry when the authoring issue is resolved.',
    );
    summary();
    return;
  }
  const proposal = validateResolutionProposal(document, result.value);
  await assertCurrent();
  const identifier = randomUUID();
  const proposalFile = await artifact(`${identifier}.proposal.json`);
  const diffFile = await artifact(`${identifier}.diff.txt`);
  await writeNew(
    proposalFile,
    JSON.stringify(
      {
        schema_version: 1,
        created_at: new Date().toISOString(),
        source: file,
        source_sha256: sha256(raw),
        proposal,
      },
      null,
      2,
    ) + '\n',
  );
  await writeNew(diffFile, formatResolutionChanges(document, proposal) + '\n');
  log(`Saved review: ${diffFile}\nProposal: ${proposalFile}`);
  // --yes covers authoring consent, never unseen freshly generated requirement changes.
  const applied = await reviewAndApply(proposal, false);
  if (!applied)
    log(
      `Review this saved proposal without another AI call: ${projectCommand(root, ['urs', 'resolve', path.relative(root, file), '--apply', path.relative(root, proposalFile)])}`,
    );
  summary();
}
