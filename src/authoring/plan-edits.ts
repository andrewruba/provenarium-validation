import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  accessSchema,
  assertionSchema,
  caseSchema,
  evidenceSchema,
  locatorSchema,
  planSchema,
  questionSchema,
  stepSchema,
  type Plan,
  type Urs,
} from '../schema.js';
import { assertionContractIssues } from '../assertion-contract.js';
import { obligationSourceCatalog, validatePlanStructure } from '../compiler.js';
import { planInputPathError } from '../plan-inputs.js';

const id = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)
  .max(100);
const text = z.string().trim().min(1);
const fixtureSchema = z.strictObject({ path: text, content: z.string().max(100000) });
const obligationSchema = planSchema.shape.obligations.element;
const operations = [
  z.strictObject({ op: z.literal('add_case'), value: caseSchema }),
  z.strictObject({
    op: z.literal('add_step'),
    case_id: id,
    value: stepSchema,
    after_step_id: id.optional(),
  }),
  z.strictObject({
    op: z.literal('add_assertion'),
    case_id: id,
    step_id: id,
    value: assertionSchema,
  }),
  z.strictObject({
    op: z.literal('add_evidence'),
    case_id: id,
    step_id: id,
    value: evidenceSchema,
  }),
  z.strictObject({ op: z.literal('add_obligation'), value: obligationSchema }),
  z.strictObject({
    op: z.literal('extend_obligation'),
    obligation_id: id,
    assertion_ids: z.array(id),
    manual_case_ids: z.array(id),
  }),
  z.strictObject({ op: z.literal('add_case_requirement'), case_id: id, requirement_id: id }),
  z.strictObject({ op: z.literal('add_actor'), value: accessSchema }),
  z.strictObject({ op: z.literal('add_actor_case'), actor_id: id, case_id: id }),
  z.strictObject({ op: z.literal('add_question'), value: questionSchema }),
  z.strictObject({ op: z.literal('add_fixture'), value: fixtureSchema }),
  z.strictObject({
    op: z.literal('update_instruction'),
    case_id: id,
    step_id: id,
    instruction: text,
  }),
  z.strictObject({
    op: z.literal('update_action_locator'),
    case_id: id,
    step_id: id,
    action_index: z.number().int().nonnegative(),
    locator: locatorSchema,
  }),
  z.strictObject({
    op: z.literal('update_action_url'),
    case_id: id,
    step_id: id,
    action_index: z.number().int().nonnegative(),
    url: text,
  }),
  z.strictObject({
    op: z.literal('update_assertion_locator'),
    assertion_id: id,
    locator: locatorSchema,
  }),
] as const;
const repairs = [
  z.strictObject({
    op: z.literal('repair_assertion'),
    assertion_id: id,
    comparison: assertionSchema.shape.comparison.optional(),
    expected: assertionSchema.shape.expected,
    tolerance: assertionSchema.shape.tolerance,
  }),
  z.strictObject({ op: z.literal('repair_obligation_source'), obligation_id: id, source: text }),
  z.strictObject({
    op: z.literal('repair_question_requirement'),
    question_id: id,
    requirement_id: id,
  }),
  z.strictObject({ op: z.literal('remove_technical_question'), question_id: id }),
  z.strictObject({
    op: z.literal('set_input_declarations'),
    fixtures: z.array(text),
    references: z.array(text),
  }),
  z.strictObject({
    op: z.literal('repair_actor'),
    actor_id: id,
    state: accessSchema.shape.state.optional(),
    mode: accessSchema.shape.mode.optional(),
    cases: z.array(id).optional(),
    distinct_from: z.array(id).optional(),
  }),
] as const;

const requirementRevisions = [
  z.strictObject({
    op: z.literal('revise_assertion'),
    assertion_id: id,
    comparison: assertionSchema.shape.comparison.optional(),
    expected: assertionSchema.shape.expected,
    tolerance: assertionSchema.shape.tolerance,
  }),
  z.strictObject({ op: z.literal('revise_manual_expected'), case_id: id, expected: text }),
] as const;
const questionResolutions = [
  z.strictObject({
    op: z.literal('resolve_question'),
    question_id: id,
    supporting_quote: text,
    resolution: text,
  }),
] as const;

/** No operation can delete a case/assertion; predicate revisions require explicit URS changes. */
export const planEditsSchema = z.strictObject({
  edits: z
    .array(
      z.discriminatedUnion('op', [
        ...operations,
        ...repairs,
        ...requirementRevisions,
        ...questionResolutions,
      ]),
    )
    .max(100),
});
export const planReviewEditsSchema = z.strictObject({
  edits: z.array(z.discriminatedUnion('op', operations)).max(100),
});
export type PlanEdits = z.infer<typeof planEditsSchema>;
export type GeneratedPlanDocument = { plan: Plan; fixtures: { path: string; content: string }[] };
export type PredicateField = 'comparison' | 'expected' | 'tolerance';
export type PlanEditOptions = {
  mode: 'review' | 'technical';
  urs: Urs;
  /** A caller may narrow diagnosed repair fields, never broaden them. */
  repairableAssertionFields?: ReadonlyMap<string, ReadonlySet<PredicateField>>;
  /** Only an explicit changed URS authorizes replacing an existing expected result. */
  authorizedRequirementChanges?: ReadonlySet<string>;
  /** Explicit human feedback must name the question ID and supply its answer evidence. */
  questionResolutionFeedback?: string;
};
export type PlanEditChange = {
  op: PlanEdits['edits'][number]['op'];
  target: string;
  before?: unknown;
  after?: unknown;
};
export class PlanEditError extends Error {
  override name = 'PlanEditError';
  constructor(readonly issues: PlanEditIssue[]) {
    super(`Scoped protocol edits were rejected: ${issues.map((issue) => issue.message).join(' ')}`);
  }
}
export type PlanEditIssue = {
  path: (string | number)[];
  code: string;
  message: string;
  before?: unknown;
  proposed?: unknown;
};

export function makePlanEditsSchema(
  base: GeneratedPlanDocument,
  options: Pick<
    PlanEditOptions,
    'mode' | 'authorizedRequirementChanges' | 'questionResolutionFeedback'
  >,
) {
  const mayRevise = base.plan.cases.some(
    (c) =>
      c.requirements.length &&
      c.requirements.every((id) => options.authorizedRequirementChanges?.has(id)),
  );
  const resolvableQuestionIds = base.plan.questions
    .filter((question) => feedbackNamesQuestion(options.questionResolutionFeedback, question.id))
    .map((question) => question.id);
  const mayResolve = resolvableQuestionIds.length > 0;
  if (options.mode === 'review' && !mayRevise && !mayResolve) return planReviewEditsSchema;
  return z.strictObject({
    edits: z
      .array(
        z.discriminatedUnion('op', [
          ...operations,
          ...(options.mode === 'technical' ? repairs : []),
          ...(mayRevise ? requirementRevisions : []),
          ...(mayResolve
            ? [questionResolutions[0].extend({ question_id: z.enum(resolvableQuestionIds) })]
            : []),
        ]),
      )
      .max(100),
  });
}

function feedbackNamesQuestion(feedback: string | undefined, questionId: string): boolean {
  if (!feedback?.trim()) return false;
  const escaped = questionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9_.-])${escaped}(?=$|[^A-Za-z0-9_.-])`).test(feedback);
}

function diagnosedFields(plan: Plan): Map<string, Set<PredicateField>> {
  return new Map(
    plan.cases.flatMap((c) =>
      c.steps.flatMap((s) =>
        s.assertions.flatMap((a) => {
          const issues = assertionContractIssues(a);
          if (!issues.length) return [];
          const fields = new Set<PredicateField>(issues.map((issue) => issue.field));
          if (
            issues.some((issue) =>
              [
                'wildcard_expected',
                'wildcard_regex',
                'csv_expected',
                'alternatives_expected',
              ].includes(issue.code),
            )
          )
            for (const field of ['comparison', 'expected', 'tolerance'] as const) fields.add(field);
          return [[a.id, fields] as const];
        }),
      ),
    ),
  );
}

function knownInputs(base: GeneratedPlanDocument, urs: Urs) {
  const references = new Set(
    urs.families.flatMap((family) =>
      family.requirements.flatMap((requirement) => requirement.references),
    ),
  );
  const fixtures = new Set(base.fixtures.map((fixture) => fixture.path));
  return { references, fixtures };
}
function invalidInputDeclarations(base: GeneratedPlanDocument, urs: Urs): boolean {
  const { references, fixtures } = knownInputs(base, urs);
  const all = [...base.plan.fixtures, ...base.plan.references];
  return (
    new Set(all).size !== all.length ||
    all.some((name) => Boolean(planInputPathError(name))) ||
    base.plan.fixtures.some((name) => !fixtures.has(name)) ||
    base.plan.references.some((name) => !fixtures.has(name) && !references.has(name)) ||
    [...fixtures].some((name) => !all.includes(name)) ||
    [...references].some((name) => !base.plan.references.includes(name))
  );
}

/** Send the model explicit targets and repair permissions alongside its typed edit schema. */
export function planEditCatalog(base: GeneratedPlanDocument, options: PlanEditOptions) {
  const reqs = new Set(
    options.urs.families.flatMap((family) =>
      family.requirements.map((requirement) => requirement.id),
    ),
  );
  const errors = new Set(validatePlanStructure(base.plan, options.urs));
  return {
    mode: options.mode,
    cases: base.plan.cases.map((c) => ({
      id: c.id,
      manual: c.manual,
      steps: c.steps.map((s) => ({
        id: s.id,
        actions: s.actions.map((a, index) => ({ index, op: a.op })),
        assertions: s.assertions.map((a) => a.id),
      })),
    })),
    obligations: base.plan.obligations.map((obligation) => obligation.id),
    actors: base.plan.access.map((actor) => actor.id),
    requirements: [...reqs],
    resolvable_questions: base.plan.questions
      .filter((question) => feedbackNamesQuestion(options.questionResolutionFeedback, question.id))
      .map((question) => ({
        id: question.id,
        question: question.question,
        requirement: question.requirement,
      })),
    requirement_revision_cases: base.plan.cases
      .filter(
        (c) =>
          c.requirements.length &&
          c.requirements.every((id) => options.authorizedRequirementChanges?.has(id)),
      )
      .map((c) => ({
        id: c.id,
        assertions: c.steps.flatMap((s) => s.assertions.map((a) => a.id)),
        manual: c.manual,
      })),
    repairable_assertions:
      options.mode === 'technical'
        ? [...diagnosedFields(base.plan)]
            .map(([id, fields]) => ({
              id,
              fields: [...fields].filter(
                (field) =>
                  !options.repairableAssertionFields ||
                  options.repairableAssertionFields.get(id)?.has(field),
              ),
            }))
            .filter((item) => item.fields.length)
        : [],
    repairable_sources:
      options.mode === 'technical'
        ? base.plan.obligations
            .filter((obligation) =>
              errors.has(
                `${obligation.id}: source must point to existing text or a table in its requirement.`,
              ),
            )
            .map((obligation) => ({
              id: obligation.id,
              sources: obligationSourceCatalog(options.urs)
                .filter((source) => source.requirement_id === obligation.requirement_id)
                .map((source) => source.source),
            }))
        : [],
    repairable_questions:
      options.mode === 'technical'
        ? base.plan.questions
            .filter((question) => question.requirement && !reqs.has(question.requirement))
            .map((question) => ({
              id: question.id,
              removable:
                /runtime|schema|source.{0,20}(?:binding|syntax)|file[- ]path|compatib/i.test(
                  question.question,
                ),
            }))
        : [],
    input_declarations_repairable:
      options.mode === 'technical' && invalidInputDeclarations(base, options.urs),
    instructions:
      'Use only scoped edits. Existing IDs, assertions, valid expected values, manual expectations, coverage links, and fixture contents are preserved by application code. Propose a new explicit question if an intended result needs human clarification; never rewrite it. Repair operations are available only for the listed technical faults. Resolve only listed resolvable_questions using an exact supporting quote from the explicit human feedback and a resolution grounded in that quote. Resolution removes the active question and retains the original question, resolution, and quote in the change record; it does not authorize changes to assertions or manual expectations.',
  };
}

/** Apply a whole proposal to a clone or reject it without changing the original. */
export function applyPlanEdits(
  base: GeneratedPlanDocument,
  input: unknown,
  options: PlanEditOptions,
): { value: GeneratedPlanDocument; changes: PlanEditChange[] } {
  const parsed = makePlanEditsSchema(base, options).safeParse(input);
  if (!parsed.success)
    throw new PlanEditError(
      parsed.error.issues.map((issue) => ({
        path: issue.path.map((part) => (typeof part === 'number' ? part : String(part))),
        code: issue.code,
        message: `${issue.path.join('.') || 'edits'}: ${issue.message}`,
      })),
    );
  const proposal = parsed.data as PlanEdits;
  const value = structuredClone(base);
  const changes: PlanEditChange[] = [];
  const catalog = planEditCatalog(base, options);
  const reqs = new Set(catalog.requirements);
  const ids = new Set<string>();
  const writes = new Set<string>();
  let editIndex = -1;
  const fail = (message: string, details: Partial<Omit<PlanEditIssue, 'message'>> = {}): never => {
    throw new PlanEditError([
      {
        path: editIndex < 0 ? ['plan'] : ['edits', editIndex],
        code: 'invalid_edit',
        ...details,
        message,
      },
    ]);
  };
  const register = (name: string) => {
    if (ids.has(name)) fail(`Duplicate plan ID ${name}.`);
    ids.add(name);
  };
  const registerStep = (step: Plan['cases'][number]['steps'][number]) => {
    register(step.id);
    step.assertions.forEach((a) => register(a.id));
    step.evidence.forEach((e) => register(e.id));
  };
  const registerCase = (c: Plan['cases'][number]) => {
    register(c.id);
    c.steps.forEach(registerStep);
  };
  value.plan.cases.forEach(registerCase);
  value.plan.access.forEach((a) => register(a.id));
  value.plan.obligations.forEach((o) => register(o.id));
  value.plan.questions.forEach((q) => register(q.id));
  const write = (key: string) => {
    if (
      [...writes].some(
        (written) =>
          written === key || written.startsWith(`${key}/`) || key.startsWith(`${written}/`),
      )
    )
      fail(`Conflicting duplicate edit for ${key}.`);
    writes.add(key);
  };
  const testCase = (name: string) =>
    value.plan.cases.find((c) => c.id === name) ?? fail(`Unknown case ${name}.`);
  const step = (caseId: string, stepId: string) =>
    testCase(caseId).steps.find((s) => s.id === stepId) ??
    fail(`Unknown step ${caseId}/${stepId}.`);
  const assertion = (name: string) =>
    value.plan.cases
      .flatMap((c) => c.steps.flatMap((s) => s.assertions))
      .find((a) => a.id === name) ?? fail(`Unknown assertion ${name}.`);
  const unique = (values: readonly string[], label: string) => {
    if (new Set(values).size !== values.length) fail(`Duplicate ${label}.`);
  };
  const requireRequirements = (requirements: readonly string[]) => {
    unique(requirements, 'requirement links');
    for (const name of requirements) if (!reqs.has(name)) fail(`Unknown requirement ${name}.`);
  };
  const add = (list: string[], name: string, key: string) => {
    write(`${key}/${name}`);
    if (list.includes(name)) fail(`${key} already contains ${name}.`);
    list.push(name);
  };
  const record = (op: PlanEditChange['op'], target: string, before: unknown, after: unknown) =>
    changes.push({ op, target, before: structuredClone(before), after: structuredClone(after) });
  for (const [index, edit] of proposal.edits.entries()) {
    editIndex = index;
    switch (edit.op) {
      case 'add_case': {
        requireRequirements(edit.value.requirements);
        registerCase(edit.value);
        value.plan.cases.push(edit.value);
        record(edit.op, edit.value.id, undefined, edit.value);
        break;
      }
      case 'add_step': {
        const c = testCase(edit.case_id);
        if (c.manual) fail(`Cannot add executable steps to manual case ${c.id}.`);
        registerStep(edit.value);
        const index =
          edit.after_step_id === undefined
            ? c.steps.length
            : c.steps.findIndex((s) => s.id === edit.after_step_id) + 1;
        if (edit.after_step_id !== undefined && index === 0)
          fail(`Unknown preceding step ${edit.after_step_id}.`);
        if (edit.after_step_id !== undefined) write(`step-insertion/${c.id}/${edit.after_step_id}`);
        c.steps.splice(index, 0, edit.value);
        record(edit.op, edit.value.id, undefined, edit.value);
        break;
      }
      case 'add_assertion':
      case 'add_evidence': {
        const s = step(edit.case_id, edit.step_id);
        register(edit.value.id);
        if (edit.op === 'add_assertion') s.assertions.push(edit.value);
        else s.evidence.push(edit.value);
        record(edit.op, edit.value.id, undefined, edit.value);
        break;
      }
      case 'add_obligation': {
        requireRequirements([edit.value.requirement_id]);
        register(edit.value.id);
        value.plan.obligations.push(edit.value);
        record(edit.op, edit.value.id, undefined, edit.value);
        break;
      }
      case 'extend_obligation': {
        const o =
          value.plan.obligations.find((o) => o.id === edit.obligation_id) ??
          fail(`Unknown obligation ${edit.obligation_id}.`);
        const before = structuredClone(o);
        unique(edit.assertion_ids, 'assertion links');
        unique(edit.manual_case_ids, 'manual case links');
        for (const name of edit.assertion_ids)
          add(o.assertion_ids, name, `obligation/${o.id}/assertions`);
        for (const name of edit.manual_case_ids)
          add(o.manual_case_ids, name, `obligation/${o.id}/manual`);
        record(edit.op, o.id, before, o);
        break;
      }
      case 'add_case_requirement': {
        requireRequirements([edit.requirement_id]);
        const c = testCase(edit.case_id);
        const before = [...c.requirements];
        add(c.requirements, edit.requirement_id, `case/${c.id}/requirements`);
        record(edit.op, c.id, before, c.requirements);
        break;
      }
      case 'add_actor': {
        register(edit.value.id);
        value.plan.access.push(edit.value);
        record(edit.op, edit.value.id, undefined, edit.value);
        break;
      }
      case 'add_actor_case': {
        const a =
          value.plan.access.find((a) => a.id === edit.actor_id) ??
          fail(`Unknown actor ${edit.actor_id}.`);
        testCase(edit.case_id);
        const before = [...a.cases];
        add(a.cases, edit.case_id, `actor/${a.id}/cases`);
        record(edit.op, a.id, before, a.cases);
        break;
      }
      case 'add_question': {
        if (edit.value.requirement) requireRequirements([edit.value.requirement]);
        register(edit.value.id);
        value.plan.questions.push(edit.value);
        record(edit.op, edit.value.id, undefined, edit.value);
        break;
      }
      case 'resolve_question': {
        const original =
          base.plan.questions.find((question) => question.id === edit.question_id) ??
          fail(`Unknown original question ${edit.question_id}.`);
        if (!feedbackNamesQuestion(options.questionResolutionFeedback, original.id))
          fail(`Question ${original.id} needs explicit human feedback naming its ID.`, {
            code: 'question_resolution_not_authorized',
          });
        if (!options.questionResolutionFeedback!.includes(edit.supporting_quote))
          fail(
            `Question ${original.id} supporting quote must occur exactly in the supplied human feedback.`,
            { code: 'question_resolution_not_grounded' },
          );
        write(`question/${original.id}`);
        record(edit.op, original.id, original, {
          question_id: original.id,
          resolution: edit.resolution,
          supporting_quote: edit.supporting_quote,
        });
        value.plan.questions = value.plan.questions.filter(
          (question) => question.id !== original.id,
        );
        break;
      }
      case 'add_fixture': {
        if (
          planInputPathError(edit.value.path) ||
          !/^fixtures\/[A-Za-z0-9_./-]+\.(csv|tsv|json|txt|md)$/.test(edit.value.path)
        )
          fail('New fixture must have a safe fixtures/ text-file path.');
        if (
          value.fixtures.some((f) => f.path === edit.value.path) ||
          knownInputs(base, options.urs).references.has(edit.value.path)
        )
          fail(`Cannot replace existing input ${edit.value.path}.`);
        write(`fixture/${edit.value.path}`);
        value.fixtures.push(edit.value);
        if (
          !value.plan.fixtures.includes(edit.value.path) &&
          !value.plan.references.includes(edit.value.path)
        )
          value.plan.fixtures.push(edit.value.path);
        record(edit.op, edit.value.path, undefined, edit.value);
        break;
      }
      case 'update_instruction': {
        const s = step(edit.case_id, edit.step_id);
        write(`instruction/${s.id}`);
        record(edit.op, s.id, s.instruction, edit.instruction);
        s.instruction = edit.instruction;
        break;
      }
      case 'update_action_locator':
      case 'update_action_url': {
        const s = step(edit.case_id, edit.step_id);
        const a =
          s.actions[edit.action_index] ?? fail(`Unknown action ${s.id}/${edit.action_index}.`);
        const key = edit.op === 'update_action_locator' ? 'locator' : 'url';
        if (!(key in a)) fail(`Action ${s.id}/${edit.action_index} has no ${key} binding.`);
        write(`action/${s.id}/${edit.action_index}/${key}`);
        if (edit.op === 'update_action_locator' && 'locator' in a) {
          record(edit.op, `${s.id}/${edit.action_index}`, a.locator, edit.locator);
          a.locator = edit.locator;
        }
        if (edit.op === 'update_action_url' && 'url' in a) {
          record(edit.op, `${s.id}/${edit.action_index}`, a.url, edit.url);
          a.url = edit.url;
        }
        break;
      }
      case 'update_assertion_locator': {
        const a = assertion(edit.assertion_id);
        if (!a.locator) fail(`Assertion ${a.id} uses an observation variable, not a locator.`);
        write(`assertion/${a.id}/locator`);
        record(edit.op, a.id, a.locator, edit.locator);
        a.locator = edit.locator;
        break;
      }
      case 'repair_assertion': {
        const entry =
          catalog.repairable_assertions.find((a) => a.id === edit.assertion_id) ??
          fail(`Assertion ${edit.assertion_id} has no diagnosed repairable predicate fields.`);
        const a = assertion(edit.assertion_id);
        const before = structuredClone(a);
        const fields = ['comparison', 'expected', 'tolerance'] as const;
        if (!fields.some((field) => Object.hasOwn(edit, field)))
          fail(`Assertion ${a.id} repair contains no fields.`);
        for (const field of fields)
          if (Object.hasOwn(edit, field)) {
            if (!entry.fields.includes(field))
              fail(`Assertion ${a.id} field ${field} is protected.`, {
                path: ['edits', editIndex, field],
                code: 'protected_expectation',
                before: a[field],
                proposed: edit[field],
              });
            write(`assertion/${a.id}/${field}`);
            if (field === 'comparison') a.comparison = edit.comparison!;
            else if (field === 'expected') a.expected = edit.expected;
            else a.tolerance = edit.tolerance;
          }
        if (['present', 'absent'].includes(a.comparison))
          fail(`Assertion ${a.id} cannot replace a data predicate with presence/absence.`);
        if (assertionContractIssues(a).length)
          fail(
            `Assertion ${a.id} repair still has an invalid runtime predicate: ${assertionContractIssues(
              a,
            )
              .map((issue) => issue.message)
              .join(' ')}`,
          );
        if (isDeepStrictEqual(a, before)) fail(`Assertion ${a.id} repair made no change.`);
        record(edit.op, a.id, before, a);
        break;
      }
      case 'revise_assertion': {
        const c =
          base.plan.cases.find((c) =>
            c.steps.some((s) => s.assertions.some((a) => a.id === edit.assertion_id)),
          ) ?? fail(`Unknown original assertion ${edit.assertion_id}.`);
        if (
          !c.requirements.length ||
          !c.requirements.every((id) => options.authorizedRequirementChanges?.has(id))
        )
          fail(
            `Assertion ${edit.assertion_id} expected result is protected by unchanged requirements.`,
            { code: 'protected_expectation' },
          );
        const a = assertion(edit.assertion_id);
        const before = structuredClone(a);
        const fields = ['comparison', 'expected', 'tolerance'] as const;
        if (!fields.some((field) => Object.hasOwn(edit, field)))
          fail(`Assertion ${a.id} revision contains no fields.`);
        for (const field of fields)
          if (Object.hasOwn(edit, field)) {
            write(`assertion/${a.id}/${field}`);
            if (field === 'comparison') a.comparison = edit.comparison!;
            else if (field === 'expected') a.expected = edit.expected;
            else a.tolerance = edit.tolerance;
          }
        if (assertionContractIssues(a).length)
          fail(`Assertion ${a.id} revision has an invalid runtime predicate.`);
        record(edit.op, a.id, before, a);
        break;
      }
      case 'revise_manual_expected': {
        const baseline =
          base.plan.cases.find((c) => c.id === edit.case_id) ??
          fail(`Unknown original case ${edit.case_id}.`);
        if (
          !baseline.manual ||
          !baseline.requirements.length ||
          !baseline.requirements.every((id) => options.authorizedRequirementChanges?.has(id))
        )
          fail(
            `Manual expected result for ${edit.case_id} is protected by unchanged requirements.`,
            {
              code: 'protected_expectation',
              before: baseline.manual_expected,
              proposed: edit.expected,
            },
          );
        const c = testCase(edit.case_id);
        write(`manual-expected/${c.id}`);
        record(edit.op, c.id, c.manual_expected, edit.expected);
        c.manual_expected = edit.expected;
        break;
      }
      case 'repair_obligation_source': {
        const entry =
          catalog.repairable_sources.find((o) => o.id === edit.obligation_id) ??
          fail(`Obligation ${edit.obligation_id} has no invalid source binding.`);
        if (!entry.sources.includes(edit.source))
          fail(`Obligation ${edit.obligation_id} source is not in its requirement catalog.`);
        const o = value.plan.obligations.find((o) => o.id === edit.obligation_id)!;
        write(`source/${o.id}`);
        record(edit.op, o.id, o.source, edit.source);
        o.source = edit.source;
        break;
      }
      case 'repair_question_requirement':
      case 'remove_technical_question': {
        const entry =
          catalog.repairable_questions.find((q) => q.id === edit.question_id) ??
          fail(`Question ${edit.question_id} is not a diagnosed technical binding error.`);
        const q = value.plan.questions.find((q) => q.id === edit.question_id)!;
        write(`question/${q.id}`);
        if (edit.op === 'repair_question_requirement') {
          requireRequirements([edit.requirement_id]);
          record(edit.op, q.id, q.requirement, edit.requirement_id);
          q.requirement = edit.requirement_id;
        } else {
          if (!entry.removable)
            fail(`Question ${q.id} is not a removable runtime-format question.`);
          record(edit.op, q.id, q, undefined);
          value.plan.questions = value.plan.questions.filter((item) => item.id !== q.id);
        }
        break;
      }
      case 'set_input_declarations': {
        if (!catalog.input_declarations_repairable) fail('Valid input declarations are protected.');
        write('input-declarations');
        const before = { fixtures: value.plan.fixtures, references: value.plan.references };
        const known = knownInputs(value, options.urs);
        const all = [...edit.fixtures, ...edit.references];
        unique(all, 'input declarations');
        if (all.some((name) => planInputPathError(name)))
          fail('Input declarations must use safe project-relative paths.');
        if (
          edit.fixtures.some((name) => !known.fixtures.has(name)) ||
          edit.references.some((name) => !known.fixtures.has(name) && !known.references.has(name))
        )
          fail('Input declarations must name generated fixtures or reviewed normative references.');
        if (
          [...known.fixtures].some((name) => !all.includes(name)) ||
          [...known.references].some((name) => !edit.references.includes(name))
        )
          fail('Input repair cannot omit supplied fixtures or normative references.');
        value.plan.fixtures = edit.fixtures;
        value.plan.references = edit.references;
        record(edit.op, 'inputs', before, { fixtures: edit.fixtures, references: edit.references });
        break;
      }
      case 'repair_actor': {
        const a =
          value.plan.access.find((a) => a.id === edit.actor_id) ??
          fail(`Unknown actor ${edit.actor_id}.`);
        const baseline =
          base.plan.access.find((a) => a.id === edit.actor_id) ??
          fail('New actors cannot be repaired in the same proposal.');
        const before = structuredClone(a);
        const invalidMode =
          (baseline.mode === 'anonymous') !== (baseline.state === 'signed_out') ||
          (baseline.mode === 'session' && baseline.state !== 'active');
        if (edit.state !== undefined || edit.mode !== undefined) {
          if (!invalidMode) fail(`Actor ${a.id} has valid protected access semantics.`);
          write(`actor/${a.id}/access`);
          a.state = edit.state ?? a.state;
          a.mode = edit.mode ?? a.mode;
        }
        if (edit.cases !== undefined) {
          const known = new Set(base.plan.cases.map((c) => c.id));
          if (baseline.cases.every((id) => known.has(id)))
            fail(
              `Actor ${a.id} case declarations are valid; use add_actor_case for additional consumers.`,
            );
          if (baseline.cases.filter((id) => known.has(id)).some((id) => !edit.cases!.includes(id)))
            fail(`Actor ${a.id} repair removed a valid case consumer.`);
          if (edit.cases.some((id) => !value.plan.cases.some((c) => c.id === id)))
            fail('Actor repair still references an unknown case.');
          unique(edit.cases, 'actor cases');
          write(`actor/${a.id}/cases`);
          a.cases = edit.cases;
        }
        if (edit.distinct_from !== undefined) {
          const known = new Set(base.plan.access.map((a) => a.id));
          const valid = baseline.distinct_from.filter((id) => id !== baseline.id && known.has(id));
          if (valid.length === baseline.distinct_from.length)
            fail(`Actor ${a.id} distinct-account links are valid.`);
          if (valid.some((id) => !edit.distinct_from!.includes(id)))
            fail(`Actor ${a.id} repair removed a valid distinct-account link.`);
          if (
            edit.distinct_from.some(
              (id) => id === a.id || !value.plan.access.some((actor) => actor.id === id),
            )
          )
            fail('Actor repair still has an invalid distinct-account link.');
          unique(edit.distinct_from, 'distinct-account links');
          write(`actor/${a.id}/distinct`);
          a.distinct_from = edit.distinct_from;
        }
        if (
          (a.mode === 'anonymous') !== (a.state === 'signed_out') ||
          (a.mode === 'session' && a.state !== 'active')
        )
          fail(`Actor ${a.id} repair still has incompatible state and mode.`);
        if (isDeepStrictEqual(a, before)) fail(`Actor ${a.id} repair made no change.`);
        record(edit.op, a.id, before, a);
        break;
      }
    }
  }
  // A technical proposal may leave a diagnosed baseline fault for the next bounded
  // correction, but it cannot introduce a new broken link or malformed test.
  value.plan = planSchema.parse(value.plan);
  const baselineErrors = new Set(validatePlanStructure(base.plan, options.urs));
  const introduced = validatePlanStructure(value.plan, options.urs).filter(
    (message) => !baselineErrors.has(message),
  );
  if (introduced.length)
    throw new PlanEditError(
      introduced.map((message) => ({
        path: ['edits'],
        code: 'introduced_structure_error',
        message,
      })),
    );
  return { value, changes };
}
