import { ursSchema, type Urs } from './schema.js';
import { readYaml, sha256 } from './files.js';
import { checkUrsReference } from './urs-references.js';

export const blankUrs: Urs = ursSchema.parse({
  schema_version: 1,
  document: {
    id: 'URS-NEW',
    revision: '1',
    title: '',
    intended_use: '',
    roles: [],
    interfaces: [],
  },
  families: [{ id: 'workflow', title: 'Main workflow', requirements: [] }],
  open_questions: [],
});
export const templateText = `# Describe intended use, actors, inputs, limits, outputs, and independent expected values.\n# Keep stable IDs. Unknown acceptance limits belong in open_questions.\n# Add requirements under each family: id, title, statement, optional table/details/references.\nschema_version: 1\ndocument:\n  id: URS-NEW\n  revision: '1'\n  title: ''\n  intended_use: ''\n  roles: []\n  interfaces: []\nfamilies:\n  - id: workflow\n    title: Main workflow\n    requirements: []\nopen_questions: []\n`;
export async function loadUrs(file: string): Promise<Urs> {
  return ursSchema.parse(await readYaml(file));
}
export function requirements(urs: Urs) {
  return urs.families.flatMap((f) => f.requirements);
}
export type UrsQuestion = Urs['open_questions'][number];
export type QuestionStatus = 'unanswered' | 'answered' | 'resolved';

/** Bind a reviewed resolution to the question, its link, and the exact decision. */
export function questionAnswerHash(question: UrsQuestion): string {
  return sha256(
    JSON.stringify({
      id: question.id,
      question: question.question,
      requirement: question.requirement ?? null,
      answer: question.answer?.trim() ?? '',
    }),
  );
}
function validResolutionTarget(urs: Urs, target: string): boolean {
  return (
    target === 'document' ||
    (target.startsWith('requirement:') &&
      requirements(urs).some((requirement) => requirement.id === target.slice(12)))
  );
}
export function questionStatus(urs: Urs, question: UrsQuestion): QuestionStatus {
  if (!question.answer?.trim()) return 'unanswered';
  const resolution = question.resolution;
  if (
    resolution &&
    resolution.answer_hash === questionAnswerHash(question) &&
    resolution.targets.length > 0 &&
    resolution.targets.every((target) => validResolutionTarget(urs, target)) &&
    (!question.requirement || resolution.targets.includes(`requirement:${question.requirement}`))
  )
    return 'resolved';
  return 'answered';
}
export function pendingAnsweredQuestions(urs: Urs): UrsQuestion[] {
  return urs.open_questions.filter((question) => questionStatus(urs, question) === 'answered');
}
export function unresolvedQuestions(urs: Urs): UrsQuestion[] {
  return urs.open_questions.filter((question) => questionStatus(urs, question) !== 'resolved');
}
/** Validate the document shape and inputs independently of human decisions still pending. */
export async function checkUrsStructure(urs: Urs, root?: string): Promise<string[]> {
  const errors: string[] = [];
  const ids = new Set<string>();
  if (!urs.document.title.trim()) errors.push('Document title is empty.');
  if (!urs.document.intended_use.trim()) errors.push('Intended use is empty.');
  if (!requirements(urs).length)
    errors.push('No requirements: this template is not ready for protocol generation.');
  for (const family of urs.families) {
    if (ids.has(family.id)) errors.push(`Duplicate ID: ${family.id}`);
    ids.add(family.id);
    for (const req of family.requirements) {
      if (ids.has(req.id)) errors.push(`Duplicate ID: ${req.id}`);
      ids.add(req.id);
      if (!req.applicable && !req.non_applicability_reason?.trim())
        errors.push(`${req.id}: non-applicability needs a rationale.`);
      if (
        /\b(TODO|TBD|FIXME)\b|<placeholder>/i.test(
          [req.statement, ...(req.details ?? []), ...(req.table?.rows.flat() ?? [])].join(' '),
        )
      )
        errors.push(`${req.id}: unresolved placeholder.`);
      if (req.table?.rows.some((r) => r.length !== req.table!.columns.length))
        errors.push(`${req.id}: table row width differs from headers.`);
      for (const reference of req.references) {
        const error = await checkUrsReference(req.id, reference, root);
        if (error) errors.push(error);
      }
    }
  }
  for (const question of urs.open_questions) {
    if (ids.has(question.id)) errors.push(`Duplicate ID: ${question.id}`);
    ids.add(question.id);
    if (question.requirement && !requirements(urs).some((r) => r.id === question.requirement))
      errors.push(`${question.id}: unknown requirement ${question.requirement}`);
    if (question.resolution) {
      for (const target of question.resolution.targets)
        if (!validResolutionTarget(urs, target))
          errors.push(`${question.id}: unknown resolution target ${target}.`);
      if (new Set(question.resolution.targets).size !== question.resolution.targets.length)
        errors.push(`${question.id}: duplicate resolution targets.`);
    }
  }
  return errors;
}
export async function checkUrs(urs: Urs, root?: string): Promise<string[]> {
  const errors = await checkUrsStructure(urs, root);
  for (const question of urs.open_questions) {
    const status = questionStatus(urs, question);
    if (status === 'unanswered')
      errors.push(
        `${question.id}: ${question.question} Answer beside the question in YAML or run provenarium urs resolve <file>.`,
      );
    else if (status === 'answered')
      errors.push(
        `${question.id}: answer recorded but requirement changes need review. Run provenarium urs resolve <file>.`,
      );
  }
  return errors;
}
