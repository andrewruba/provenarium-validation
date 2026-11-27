import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  accessSchema,
  assertionSchema,
  caseSchema,
  evidenceSchema,
  locatorSchema,
  manualReasonSchema,
  planQuestionSchema,
  planSchema,
  stepSchema,
  type Plan,
  type Urs,
} from '../schema.js';
import { assertionContractIssues } from '../assertion-contract.js';
import { obligationSourceCatalog, validatePlanStructure } from '../compiler.js';
import { planInputPathError } from '../plan-inputs.js';
import { auditAutomation } from './automation-policy.js';

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
  z.strictObject({ op: z.literal('add_question'), value: planQuestionSchema }),
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
  z.strictObject({
    op: z.literal('revise_fixture'),
    path: z.string().min(1),
    content: fixtureSchema.shape.content,
    reason: text,
  }),
] as const;
const questionResolutions = [
  z.strictObject({
    op: z.literal('resolve_question'),
    question_id: id,
    supporting_quote: text,
    resolution: text,
  }),
  z.strictObject({
    op: z.literal('reclassify_question_as_preparation'),
    question_id: id,
    case_ids: z.array(id).min(1),
    supporting_quote: text,
    resolution: text,
  }),
] as const;
const automationOperations = [
  z.strictObject({
    op: z.literal('automate_case'),
    case_id: id,
    preserved_manual_expected: z.string().min(1),
    steps: z.array(stepSchema).min(1),
    coverage: z.array(z.strictObject({ obligation_id: id, assertion_ids: z.array(id).min(1) })),
    preparation_resolutions: z
      .array(z.strictObject({ question_id: id, explanation: text }))
      .optional(),
    automated_prerequisites: z
      .array(z.strictObject({ prerequisite: z.string().min(1), explanation: text }))
      .optional(),
  }),
] as const;
const manualJustificationOperations = [
  z.strictObject({ op: z.literal('justify_manual_case'), case_id: id, reason: manualReasonSchema }),
] as const;
const proceduralOperations = [operations[11], operations[12], operations[14]] as const;
const proceduralEditsSchema = z.strictObject({
  edits: z.array(z.discriminatedUnion('op', proceduralOperations)).max(100),
});

/** No operation can delete a case/assertion; expectation revisions require scoped permission. */
export const planEditsSchema = z.strictObject({
  edits: z
    .array(
      z.discriminatedUnion('op', [
        ...operations,
        ...repairs,
        ...requirementRevisions,
        ...questionResolutions,
        ...automationOperations,
        ...manualJustificationOperations,
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
  /** Conversion produces a new candidate; accepted source packages stay immutable. */
  allowManualConversion?: boolean;
  /** Only explicit user permission can enable grounded manual exceptions. */
  allowManualExceptions?: boolean;
  /** A newly generated, unreviewed draft can revise expectations during semantic review. */
  allowDraftExpectationRevision?: boolean;
  /** After final semantic review, only instructions and locator bindings may change. */
  proceduralOnly?: boolean;
  /** Author one manual conversion at a time against the complete local baseline. */
  automationCaseId?: string;
  /** Restrict an oversized request to these existing cases; apply still sees the full plan. */
  scopedCaseIds?: readonly string[];
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
    | 'mode'
    | 'authorizedRequirementChanges'
    | 'questionResolutionFeedback'
    | 'allowManualConversion'
    | 'allowManualExceptions'
    | 'allowDraftExpectationRevision'
    | 'proceduralOnly'
    | 'automationCaseId'
    | 'scopedCaseIds'
  >,
): z.ZodType<PlanEdits> {
  if (options.proceduralOnly) return narrowScopedSchema(proceduralEditsSchema, base, options);
  if (options.automationCaseId !== undefined) {
    const c = base.plan.cases.find((item) => item.id === options.automationCaseId);
    if (!options.allowManualConversion || !c?.manual)
      throw new PlanEditError([
        {
          path: ['scope'],
          code: 'invalid_scope',
          message:
            'An automation request needs one existing manual case and explicit conversion permission.',
        },
      ]);
    if (options.scopedCaseIds && !options.scopedCaseIds.includes(c.id))
      throw new PlanEditError([
        {
          path: ['scope'],
          code: 'invalid_scope',
          message: 'The automation case is outside the selected case scope.',
        },
      ]);
    return z.strictObject({
      edits: z
        .array(
          z.discriminatedUnion('op', [
            automationOperations[0].extend({ case_id: z.literal(c.id) }),
            operations[10],
          ]),
        )
        .max(51),
    });
  }
  const mayRevise =
    (options.mode === 'review' && options.allowDraftExpectationRevision) ||
    base.plan.cases.some(
      (c) =>
        c.requirements.length &&
        c.requirements.every((id) => options.authorizedRequirementChanges?.has(id)),
    );
  const resolvableQuestionIds = base.plan.questions
    .filter((question) => feedbackNamesQuestion(options.questionResolutionFeedback, question.id))
    .map((question) => question.id);
  const preparationQuestionIds = base.plan.questions
    .filter(
      (question) =>
        question.kind !== 'execution_preparation' &&
        resolvableQuestionIds.includes(question.id) &&
        preparationCases(base, question.requirement).length,
    )
    .map((question) => question.id);
  const mayResolve = resolvableQuestionIds.length > 0;
  if (
    options.mode === 'review' &&
    !mayRevise &&
    !mayResolve &&
    !options.allowManualConversion &&
    !options.allowManualExceptions
  )
    return narrowScopedSchema(planReviewEditsSchema, base, options);
  return narrowScopedSchema(
    z.strictObject({
      edits: z
        .array(
          z.discriminatedUnion('op', [
            ...operations,
            ...(options.mode === 'technical' ? repairs : []),
            ...(mayRevise ? requirementRevisions.slice(0, 2) : []),
            ...(options.mode === 'review' && options.allowDraftExpectationRevision
              ? [requirementRevisions[2]]
              : []),
            ...(options.allowManualConversion ? automationOperations : []),
            ...(options.allowManualExceptions ? manualJustificationOperations : []),
            ...(mayResolve
              ? [questionResolutions[0].extend({ question_id: z.enum(resolvableQuestionIds) })]
              : []),
            ...(preparationQuestionIds.length
              ? [questionResolutions[1].extend({ question_id: z.enum(preparationQuestionIds) })]
              : []),
          ]),
        )
        .max(100),
    }),
    base,
    options,
  );
}

type ScopeOptions = Pick<PlanEditOptions, 'scopedCaseIds' | 'automationCaseId'>;
function selectedScope(
  base: GeneratedPlanDocument,
  options: ScopeOptions,
): Set<string> | undefined {
  const selected =
    options.automationCaseId !== undefined ? [options.automationCaseId] : options.scopedCaseIds;
  if (
    options.automationCaseId !== undefined &&
    options.scopedCaseIds &&
    !options.scopedCaseIds.includes(options.automationCaseId)
  )
    throw new PlanEditError([
      {
        path: ['scope'],
        code: 'invalid_scope',
        message: 'The automation case is outside the selected case scope.',
      },
    ]);
  if (!selected) return;
  if (
    !selected.length ||
    new Set(selected).size !== selected.length ||
    selected.some((id) => !base.plan.cases.some((c) => c.id === id))
  )
    throw new PlanEditError([
      {
        path: ['scope'],
        code: 'invalid_scope',
        message: 'Case scope must contain unique existing case IDs.',
      },
    ]);
  return new Set(selected);
}

/** Native schemas narrow known targets; the full-baseline guard below checks cross-links. */
function narrowScopedSchema(
  schema: z.ZodType<PlanEdits>,
  base: GeneratedPlanDocument,
  options: ScopeOptions,
): z.ZodType<PlanEdits> {
  const selected = selectedScope(base, options);
  if (!selected) return schema;
  const cases = base.plan.cases.filter((c) => selected.has(c.id));
  const assertions = cases.flatMap((c) => c.steps.flatMap((s) => s.assertions.map((a) => a.id)));
  const actors = base.plan.access
    .filter((a) => a.cases.length && a.cases.every((id) => selected.has(id)))
    .map((a) => a.id);
  const variants: z.ZodObject[] = [];
  for (const original of (schema as typeof planEditsSchema).shape.edits.element.options) {
    const op = original.shape.op.value;
    if (op === 'set_input_declarations' || op === 'revise_fixture') continue;
    if (op === 'repair_actor' && !actors.length) continue;
    if ('assertion_id' in original.shape && !assertions.length) continue;
    let variant: z.ZodObject = original;
    if ('case_id' in original.shape) variant = variant.extend({ case_id: z.enum([...selected]) });
    if ('assertion_id' in original.shape)
      variant = variant.extend({ assertion_id: z.enum(assertions) });
    if (op === 'repair_actor') variant = variant.extend({ actor_id: z.enum(actors) });
    variants.push(variant);
  }
  return z.strictObject({
    edits: z
      .array(z.discriminatedUnion('op', variants as [z.ZodObject, ...z.ZodObject[]]))
      .max(100),
  }) as unknown as z.ZodType<PlanEdits>;
}

function enforceEditScope(
  base: GeneratedPlanDocument,
  proposal: PlanEdits,
  options: ScopeOptions,
): Set<string> | undefined {
  const selected = selectedScope(base, options);
  if (!selected) return;
  const requirements = new Set(
    base.plan.cases.filter((c) => selected.has(c.id)).flatMap((c) => c.requirements),
  );
  const allowedCases = new Set(selected);
  for (const edit of proposal.edits) if (edit.op === 'add_case') allowedCases.add(edit.value.id);
  const assertionOwners = new Map(
    base.plan.cases.flatMap((c) =>
      c.steps.flatMap((s) => s.assertions.map((a) => [a.id, c.id] as const)),
    ),
  );
  for (const edit of proposal.edits) {
    if (edit.op === 'add_case')
      for (const s of edit.value.steps)
        for (const a of s.assertions) assertionOwners.set(a.id, edit.value.id);
    else if (edit.op === 'add_step')
      for (const a of edit.value.assertions) assertionOwners.set(a.id, edit.case_id);
    else if (edit.op === 'add_assertion') assertionOwners.set(edit.value.id, edit.case_id);
    else if (edit.op === 'automate_case')
      for (const s of edit.steps)
        for (const a of s.assertions) assertionOwners.set(a.id, edit.case_id);
  }
  const questionInScope = (q: Plan['questions'][number] | undefined) =>
    Boolean(
      q &&
      ((q.requirement && requirements.has(q.requirement)) ||
        q.case_ids?.some((id) => selected.has(id))),
    );
  for (const [index, edit] of proposal.edits.entries()) {
    const fail = (message: string): never => {
      throw new PlanEditError([{ path: ['edits', index], code: 'out_of_scope_edit', message }]);
    };
    const requireCase = (id: string) => {
      if (!allowedCases.has(id)) fail(`Case ${id} is outside the selected case scope.`);
    };
    const requireRequirement = (id: string) => {
      if (!requirements.has(id)) fail(`Requirement ${id} is outside the selected case scope.`);
    };
    const requireAssertion = (id: string) => {
      const owner = assertionOwners.get(id);
      if (!owner || !allowedCases.has(owner))
        fail(`Assertion ${id} is outside the selected case scope.`);
    };
    const requireQuestion = (id: string) => {
      if (!questionInScope(base.plan.questions.find((q) => q.id === id)))
        fail(`Question ${id} is outside the selected case scope.`);
    };
    if ('case_id' in edit) requireCase(edit.case_id);
    if ('assertion_id' in edit) requireAssertion(edit.assertion_id);
    switch (edit.op) {
      case 'add_case':
        edit.value.requirements.forEach(requireRequirement);
        break;
      case 'add_case_requirement':
        requireRequirement(edit.requirement_id);
        break;
      case 'add_obligation':
        requireRequirement(edit.value.requirement_id);
        edit.value.assertion_ids.forEach(requireAssertion);
        edit.value.manual_case_ids.forEach(requireCase);
        break;
      case 'extend_obligation':
      case 'repair_obligation_source': {
        const obligation = base.plan.obligations.find((o) => o.id === edit.obligation_id);
        if (!obligation) fail(`Unknown scoped obligation ${edit.obligation_id}.`);
        requireRequirement(obligation!.requirement_id);
        if (edit.op === 'extend_obligation') {
          edit.assertion_ids.forEach(requireAssertion);
          edit.manual_case_ids.forEach(requireCase);
        }
        break;
      }
      case 'add_question':
        if (edit.value.requirement) requireRequirement(edit.value.requirement);
        else if (!edit.value.case_ids?.length)
          fail('A scoped request cannot add an unbound global question.');
        edit.value.case_ids?.forEach(requireCase);
        break;
      case 'resolve_question':
      case 'remove_technical_question':
        requireQuestion(edit.question_id);
        break;
      case 'repair_question_requirement':
        requireQuestion(edit.question_id);
        requireRequirement(edit.requirement_id);
        break;
      case 'reclassify_question_as_preparation':
        requireQuestion(edit.question_id);
        edit.case_ids.forEach(requireCase);
        break;
      case 'add_actor':
        if (!edit.value.cases.length) fail('A scoped actor must name its case consumers.');
        edit.value.cases.forEach(requireCase);
        break;
      case 'repair_actor': {
        const actor = base.plan.access.find((a) => a.id === edit.actor_id);
        if (!actor?.cases.length || actor.cases.some((id) => !selected.has(id)))
          fail(`Actor ${edit.actor_id} has consumers outside the selected case scope.`);
        edit.cases?.forEach(requireCase);
        break;
      }
      case 'set_input_declarations':
      case 'revise_fixture':
        fail(
          `${edit.op} is not available in a scoped case request; shared inputs remain protected.`,
        );
    }
  }
  return selected;
}

function feedbackNamesQuestion(feedback: string | undefined, questionId: string): boolean {
  if (!feedback?.trim()) return false;
  const escaped = questionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9_.-])${escaped}(?=$|[^A-Za-z0-9_.-])`).test(feedback);
}

function preparationCases(base: GeneratedPlanDocument, requirement?: string) {
  return base.plan.cases.filter(
    (c) =>
      c.manual &&
      c.prerequisites.some((prerequisite) => prerequisite.trim()) &&
      c.manual_procedure?.trim() &&
      c.manual_expected?.trim() &&
      (!requirement || c.requirements.includes(requirement)),
  );
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
  if (options.proceduralOnly)
    options = {
      ...options,
      mode: 'review',
      allowManualConversion: false,
      allowManualExceptions: false,
      allowDraftExpectationRevision: false,
      authorizedRequirementChanges: undefined,
      questionResolutionFeedback: undefined,
    };
  const selected = selectedScope(base, options);
  const inScope = (c: Plan['cases'][number]) => !selected || selected.has(c.id);
  const scopeRequirements = new Set(base.plan.cases.filter(inScope).flatMap((c) => c.requirements));
  const scopeAssertions = new Set(
    base.plan.cases
      .filter(inScope)
      .flatMap((c) => c.steps.flatMap((s) => s.assertions.map((a) => a.id))),
  );
  const questionInScope = (q: Plan['questions'][number]) =>
    !selected ||
    Boolean(
      (q.requirement && scopeRequirements.has(q.requirement)) ||
      q.case_ids?.some((id) => selected.has(id)),
    );
  const conversionOnly = options.automationCaseId !== undefined && !options.proceduralOnly;
  const reqs = new Set(
    options.urs.families.flatMap((family) =>
      family.requirements.map((requirement) => requirement.id),
    ),
  );
  const errors = new Set(validatePlanStructure(base.plan, options.urs));
  return {
    mode: options.mode,
    procedural_only: Boolean(options.proceduralOnly),
    ...(selected ? { scoped_case_ids: [...selected] } : {}),
    ...(conversionOnly ? { permitted_operations: ['automate_case', 'add_fixture'] } : {}),
    ...(options.proceduralOnly
      ? {
          permitted_operations: [
            'update_instruction',
            'update_action_locator',
            'update_assertion_locator',
          ],
        }
      : {}),
    cases: base.plan.cases.filter(inScope).map((c) => ({
      id: c.id,
      manual: c.manual,
      steps: c.steps.map((s) => ({
        id: s.id,
        actions: s.actions.map((a, index) => ({ index, op: a.op })),
        assertions: s.assertions.map((a) => a.id),
      })),
    })),
    obligations: base.plan.obligations
      .filter((o) => !selected || scopeRequirements.has(o.requirement_id))
      .map((obligation) => obligation.id),
    actors: base.plan.access.map((actor) => actor.id),
    requirements: [...reqs],
    automatable_cases: options.allowManualConversion
      ? base.plan.cases
          .filter((c) => c.manual && inScope(c))
          .map((c) => ({
            id: c.id,
            manual_procedure: c.manual_procedure,
            prerequisites: c.prerequisites,
            preserved_manual_expected: c.manual_expected,
            obligations: base.plan.obligations
              .filter((o) => o.manual_case_ids.includes(c.id))
              .map((o) => ({ id: o.id, statement: o.statement })),
            preparation_questions: base.plan.questions
              .filter((q) => q.kind === 'execution_preparation' && q.case_ids?.includes(c.id))
              .map((q) => ({ id: q.id, question: q.question, case_ids: q.case_ids })),
          }))
      : [],
    manual_justification_cases:
      options.allowManualExceptions && !conversionOnly
        ? base.plan.cases
            .filter((c) => c.manual && inScope(c))
            .map((c) => ({
              id: c.id,
              sources: obligationSourceCatalog(options.urs).filter((source) =>
                c.requirements.includes(source.requirement_id),
              ),
            }))
        : [],
    provisional_expectation_revision:
      !conversionOnly &&
      options.mode === 'review' &&
      Boolean(options.allowDraftExpectationRevision),
    revisable_fixtures:
      !selected && options.mode === 'review' && options.allowDraftExpectationRevision
        ? base.fixtures
            .filter(
              (fixture) =>
                !planInputPathError(fixture.path) &&
                /^fixtures\/[A-Za-z0-9_./-]+\.(csv|tsv|json|txt|md)$/.test(fixture.path) &&
                !knownInputs(base, options.urs).references.has(fixture.path) &&
                (base.plan.fixtures.includes(fixture.path) ||
                  base.plan.references.includes(fixture.path)),
            )
            .map((fixture) => fixture.path)
        : [],
    resolvable_questions: base.plan.questions
      .filter(
        (question) =>
          !conversionOnly &&
          questionInScope(question) &&
          feedbackNamesQuestion(options.questionResolutionFeedback, question.id),
      )
      .map((question) => ({
        id: question.id,
        question: question.question,
        requirement: question.requirement,
      })),
    preparation_questions: base.plan.questions
      .filter(
        (question) =>
          question.kind !== 'execution_preparation' &&
          !conversionOnly &&
          questionInScope(question) &&
          feedbackNamesQuestion(options.questionResolutionFeedback, question.id),
      )
      .map((question) => ({
        id: question.id,
        question: question.question,
        requirement: question.requirement,
        manual_case_ids: preparationCases(base, question.requirement).map((c) => c.id),
      }))
      .filter((question) => question.manual_case_ids.length),
    requirement_revision_cases: base.plan.cases
      .filter(
        (c) =>
          !conversionOnly &&
          inScope(c) &&
          c.requirements.length &&
          ((options.mode === 'review' && options.allowDraftExpectationRevision) ||
            c.requirements.every((id) => options.authorizedRequirementChanges?.has(id))),
      )
      .map((c) => ({
        id: c.id,
        assertions: c.steps.flatMap((s) => s.assertions.map((a) => a.id)),
        manual: c.manual,
      })),
    repairable_assertions:
      !conversionOnly && options.mode === 'technical'
        ? [...diagnosedFields(base.plan)]
            .map(([id, fields]) => ({
              id,
              fields: [...fields].filter(
                (field) =>
                  !options.repairableAssertionFields ||
                  options.repairableAssertionFields.get(id)?.has(field),
              ),
            }))
            .filter((item) => item.fields.length && (!selected || scopeAssertions.has(item.id)))
        : [],
    repairable_sources:
      !conversionOnly && options.mode === 'technical'
        ? base.plan.obligations
            .filter(
              (obligation) =>
                (!selected || scopeRequirements.has(obligation.requirement_id)) &&
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
      !conversionOnly && options.mode === 'technical'
        ? base.plan.questions
            .filter(
              (question) =>
                questionInScope(question) &&
                question.requirement &&
                !reqs.has(question.requirement),
            )
            .map((question) => ({
              id: question.id,
              removable:
                /runtime|schema|source.{0,20}(?:binding|syntax)|file[- ]path|compatib/i.test(
                  question.question,
                ),
            }))
        : [],
    input_declarations_repairable:
      !selected && options.mode === 'technical' && invalidInputDeclarations(base, options.urs),
    instructions:
      (selected
        ? `This request may edit only cases ${[...selected].join(', ')} and coverage for their requirements. Other cases and shared inputs remain protected; create any additional case as a complete object under these same requirements. `
        : '') +
      (options.proceduralOnly
        ? 'This is a post-review procedural repair. Only update_instruction, update_action_locator, and update_assertion_locator are permitted. All test behavior, expectations, actions, coverage, questions, fixtures, and case membership are frozen. '
        : '') +
      'automate_case is available only for listed automatable_cases. Preserve the original manual expected result verbatim and implement its full behavior with executable data assertions. Map every currently manual obligation exactly once to new assertions in this case. Conversion retains the original procedure and expectation for audit and replaces manual coverage atomically. If conversion eliminates a listed execution_preparation job, supply preparation_resolutions with its ID and a concrete explanation of how the automated steps complete it; this cannot resolve requirement_decision questions. automated_prerequisites may remove only exact existing prerequisite strings now completed by executable steps or supplied verified metadata; explain the evidence for each. Preserve every unmet condition and do not claim external evidence was obtained. justify_manual_case requires an exact quoted requirement establishing a specific external dependency or explicit manual activity, never a missing ordinary browser capability. ' +
      (options.mode === 'review' && options.allowDraftExpectationRevision
        ? 'This is a provisional draft: revise_assertion and revise_manual_expected may correct unreviewed expectations to match the requirements, with audited before/after values. revise_fixture may correct only listed revisable_fixtures with a reason; keep independent derivations and their assertions consistent with the URS, never with observed app output. Do not remove coverage, evidence, or meaningful predicates. '
        : '') +
      'Use only scoped edits. Existing IDs, assertions, and coverage links are preserved by application code. Fixture contents stay protected unless the listed provisional fixture revision is explicitly authorized. Existing expected values and manual expectations may change only through explicitly authorized revision operations. Propose a new explicit question only if an intended result needs human clarification that existing evidence or delegated decisions cannot supply. Repair operations are available only for the listed technical faults. Resolve only listed resolvable_questions using an exact supporting quote from the explicit human feedback and a resolution grounded in that quote. Resolution removes the active question and retains the original question, resolution, and quote in the change record; it does not authorize changes to assertions or manual expectations. Reclassify only listed preparation_questions whose human feedback confirms a setup need for the listed existing manual cases, such as supplying a deployment or collecting applicability evidence. Never reclassify an unknown intended behavior or expected result. Reclassification retains the complete question and attaches it to those manual cases; it does not satisfy the prerequisite or mark any test passed. New execution_preparation questions must likewise identify affected manual cases with defined procedures and expected results.',
  };
}

/** Provider-facing permissions point to authoritative text already in candidate/URS.
 * The full local catalog remains available to the validator; no behavior is omitted. */
export function planEditRequestCatalog(base: GeneratedPlanDocument, options: PlanEditOptions) {
  const catalog = planEditCatalog(base, options);
  return {
    ...catalog,
    automatable_cases: catalog.automatable_cases.map((c) => {
      const pointer = `/candidate/plan/cases/${base.plan.cases.findIndex((item) => item.id === c.id)}`;
      return {
        id: c.id,
        manual_procedure_pointer: `${pointer}/manual_procedure`,
        prerequisites_pointer: `${pointer}/prerequisites`,
        preserved_manual_expected_pointer: `${pointer}/manual_expected`,
        obligations: c.obligations.map((o) => ({
          id: o.id,
          statement_pointer: `/candidate/plan/obligations/${base.plan.obligations.findIndex((item) => item.id === o.id)}/statement`,
        })),
        preparation_questions: c.preparation_questions.map((q) => ({
          id: q.id,
          question_pointer: `/candidate/plan/questions/${base.plan.questions.findIndex((item) => item.id === q.id)}/question`,
          case_ids: q.case_ids,
        })),
      };
    }),
    manual_justification_cases: catalog.manual_justification_cases.map((c) => ({
      id: c.id,
      sources: c.sources.map(({ requirement_id, source }) => ({ requirement_id, source })),
    })),
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
  const scopedCases = enforceEditScope(base, proposal, options);
  const value = structuredClone(base);
  const changes: PlanEditChange[] = [];
  const catalog = planEditCatalog(base, options);
  const reqs = new Set(catalog.requirements);
  const ids = new Set<string>();
  const stepIds = new Map<string, Set<string>>();
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
  const registerStep = (caseId: string, step: Plan['cases'][number]['steps'][number]) => {
    const scopedIds = stepIds.get(caseId)!;
    if (scopedIds.has(step.id)) fail(`Duplicate step ID ${step.id} in case ${caseId}.`);
    scopedIds.add(step.id);
    step.assertions.forEach((a) => register(a.id));
    step.evidence.forEach((e) => register(e.id));
  };
  const registerCase = (c: Plan['cases'][number]) => {
    register(c.id);
    stepIds.set(c.id, new Set());
    c.steps.forEach((step) => registerStep(c.id, step));
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
      case 'automate_case': {
        const original =
          base.plan.cases.find((c) => c.id === edit.case_id) ??
          fail(`Unknown original case ${edit.case_id}.`);
        const c = testCase(edit.case_id);
        if (!original.manual || !c.manual || c.steps.length)
          fail(`Case ${c.id} must be an original manual case with no executable steps.`);
        if (
          !original.manual_expected?.trim() ||
          edit.preserved_manual_expected !== original.manual_expected ||
          c.manual_expected !== original.manual_expected
        )
          fail(
            `Case ${c.id} conversion must preserve its original manual expected result exactly.`,
            {
              code: 'protected_expectation',
              before: original.manual_expected,
              proposed: edit.preserved_manual_expected,
            },
          );
        write(`case/${c.id}/automation`);
        const before = structuredClone(c);
        const newAssertions = new Map(
          edit.steps.flatMap((s) => s.assertions.map((a) => [a.id, a] as const)),
        );
        if (!newAssertions.size)
          fail(
            `Case ${c.id} conversion needs executable assertions for its manual expected behavior.`,
          );
        const linked = value.plan.obligations.filter((o) => o.manual_case_ids.includes(c.id));
        unique(
          edit.coverage.map((entry) => entry.obligation_id),
          'conversion obligation mappings',
        );
        if (
          linked.length !== edit.coverage.length ||
          linked.some((o) => !edit.coverage.some((entry) => entry.obligation_id === o.id))
        )
          fail(
            `Case ${c.id} conversion must map every manual obligation exactly once, without adding unrelated obligations.`,
          );
        for (const entry of edit.coverage) {
          unique(entry.assertion_ids, 'conversion assertion links');
          if (entry.assertion_ids.some((id) => !newAssertions.has(id)))
            fail(
              `Obligation ${entry.obligation_id} conversion must reference only new assertions in case ${c.id}.`,
            );
          if (
            entry.assertion_ids.every((id) =>
              ['present', 'absent'].includes(newAssertions.get(id)!.comparison),
            )
          )
            fail(
              `Obligation ${entry.obligation_id} conversion requires a data predicate preserving the manual expected behavior, not presence/absence alone.`,
            );
        }
        unique(
          (edit.automated_prerequisites ?? []).map((entry) => entry.prerequisite),
          'automated prerequisites',
        );
        for (const entry of edit.automated_prerequisites ?? [])
          if (
            !original.prerequisites.includes(entry.prerequisite) ||
            !c.prerequisites.includes(entry.prerequisite)
          )
            fail(
              `Case ${c.id} automated prerequisite must match an existing original prerequisite exactly: ${entry.prerequisite}`,
            );
        if (edit.automated_prerequisites?.length) {
          const beforePrerequisites = [...c.prerequisites];
          write(`case/${c.id}/prerequisites`);
          c.prerequisites = c.prerequisites.filter(
            (prerequisite) =>
              !edit.automated_prerequisites!.some((entry) => entry.prerequisite === prerequisite),
          );
          record(edit.op, `${c.id}/prerequisites`, beforePrerequisites, {
            prerequisites: c.prerequisites,
            automated_prerequisites: edit.automated_prerequisites,
          });
        }
        const preparation = value.plan.questions.filter(
          (q) => q.kind === 'execution_preparation' && q.case_ids?.includes(c.id),
        );
        unique(
          (edit.preparation_resolutions ?? []).map((entry) => entry.question_id),
          'preparation resolutions',
        );
        for (const resolution of edit.preparation_resolutions ?? [])
          if (
            !preparation.some((q) => q.id === resolution.question_id) ||
            !base.plan.questions.some(
              (q) => q.id === resolution.question_id && q.kind === 'execution_preparation',
            )
          )
            fail(
              `Question ${resolution.question_id} is not an original execution-preparation question linked to ${c.id}.`,
            );
        for (const question of preparation) {
          const remaining = question.case_ids!.filter((id) => id !== c.id);
          const resolution = edit.preparation_resolutions?.find(
            (entry) => entry.question_id === question.id,
          );
          if (!remaining.length && !resolution)
            fail(
              `Converting ${c.id} requires an explicit preparation resolution for ${question.id}; explain how automation completes that setup job.`,
            );
          write(`question/${question.id}/automation/${c.id}`);
          const replacement = remaining.length ? { ...question, case_ids: remaining } : undefined;
          record(edit.op, question.id, question, {
            question: replacement,
            automated_case: c.id,
            explanation: resolution?.explanation,
          });
          value.plan.questions = value.plan.questions.flatMap((q) =>
            q.id === question.id ? (replacement ? [replacement] : []) : [q],
          );
        }
        edit.steps.forEach((s) => registerStep(c.id, s));
        c.manual = false;
        c.steps = edit.steps;
        delete c.manual_reason;
        for (const entry of edit.coverage) {
          const obligation = linked.find((o) => o.id === entry.obligation_id)!;
          const before = structuredClone(obligation);
          write(`obligation/${obligation.id}/manual/${c.id}`);
          obligation.manual_case_ids = obligation.manual_case_ids.filter((id) => id !== c.id);
          for (const id of entry.assertion_ids)
            add(obligation.assertion_ids, id, `obligation/${obligation.id}/assertions`);
          record(edit.op, obligation.id, before, obligation);
        }
        record(edit.op, c.id, before, c);
        break;
      }
      case 'justify_manual_case': {
        const c = testCase(edit.case_id);
        if (!c.manual) fail(`Case ${c.id} is automated and cannot receive a manual exception.`);
        write(`case/${c.id}/manual_reason`);
        const before = c.manual_reason;
        c.manual_reason = edit.reason;
        const issues = auditAutomation({ ...value.plan, cases: [c] }, options.urs, {
          allowManual: true,
        });
        if (issues.length) fail(issues.join(' '));
        record(edit.op, c.id, before, c.manual_reason);
        break;
      }
      case 'add_step': {
        const c = testCase(edit.case_id);
        if (c.manual) fail(`Cannot add executable steps to manual case ${c.id}.`);
        registerStep(c.id, edit.value);
        const index =
          edit.after_step_id === undefined
            ? c.steps.length
            : c.steps.findIndex((s) => s.id === edit.after_step_id) + 1;
        if (edit.after_step_id !== undefined && index === 0)
          fail(`Unknown preceding step ${edit.after_step_id}.`);
        if (edit.after_step_id !== undefined) write(`step-insertion/${c.id}/${edit.after_step_id}`);
        c.steps.splice(index, 0, edit.value);
        record(edit.op, `${c.id}/${edit.value.id}`, undefined, edit.value);
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
      case 'resolve_question':
      case 'reclassify_question_as_preparation': {
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
        if (edit.op === 'reclassify_question_as_preparation') {
          unique(edit.case_ids, 'preparation case links');
          const eligible = new Set(preparationCases(base, original.requirement).map((c) => c.id));
          if (
            original.kind === 'execution_preparation' ||
            edit.case_ids.some((caseId) => !eligible.has(caseId))
          )
            fail(
              `Question ${original.id} can only become preparation for existing manual cases with prerequisites, defined procedures and expected results, and the linked requirement.`,
              { code: 'question_preparation_invalid_cases' },
            );
          write(`question/${original.id}`);
          const replacement = planQuestionSchema.parse({
            ...original,
            kind: 'execution_preparation',
            case_ids: edit.case_ids,
          });
          value.plan.questions = value.plan.questions.map((question) =>
            question.id === original.id ? replacement : question,
          );
          record(edit.op, original.id, original, {
            question: replacement,
            resolution: edit.resolution,
            supporting_quote: edit.supporting_quote,
          });
        } else {
          write(`question/${original.id}`);
          record(edit.op, original.id, original, {
            question_id: original.id,
            resolution: edit.resolution,
            supporting_quote: edit.supporting_quote,
          });
          value.plan.questions = value.plan.questions.filter(
            (question) => question.id !== original.id,
          );
        }
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
      case 'revise_fixture': {
        if (
          options.mode !== 'review' ||
          !options.allowDraftExpectationRevision ||
          options.proceduralOnly ||
          !catalog.revisable_fixtures.includes(edit.path)
        )
          fail(
            `Fixture ${edit.path} is protected or is not an existing supported draft text fixture.`,
            { code: 'protected_fixture' },
          );
        const originals = base.fixtures.filter((fixture) => fixture.path === edit.path);
        if (originals.length !== 1)
          fail(`Fixture ${edit.path} must name one exact existing draft fixture.`);
        const fixture = value.fixtures.find((fixture) => fixture.path === edit.path)!;
        if (fixture.content === edit.content) fail(`Fixture ${edit.path} revision made no change.`);
        write(`fixture/${edit.path}`);
        const before = structuredClone(fixture);
        fixture.content = edit.content;
        record(edit.op, edit.path, before, { ...fixture, reason: edit.reason });
        break;
      }
      case 'update_instruction': {
        const s = step(edit.case_id, edit.step_id);
        write(`instruction/${edit.case_id}/${s.id}`);
        record(edit.op, `${edit.case_id}/${s.id}`, s.instruction, edit.instruction);
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
        write(`action/${edit.case_id}/${s.id}/${edit.action_index}/${key}`);
        if (edit.op === 'update_action_locator' && 'locator' in a) {
          record(edit.op, `${edit.case_id}/${s.id}/${edit.action_index}`, a.locator, edit.locator);
          a.locator = edit.locator;
        }
        if (edit.op === 'update_action_url' && 'url' in a) {
          record(edit.op, `${edit.case_id}/${s.id}/${edit.action_index}`, a.url, edit.url);
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
          (!(options.mode === 'review' && options.allowDraftExpectationRevision) &&
            !c.requirements.every((id) => options.authorizedRequirementChanges?.has(id)))
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
        if (
          options.mode === 'review' &&
          options.allowDraftExpectationRevision &&
          !c.requirements.every((id) => options.authorizedRequirementChanges?.has(id)) &&
          !['present', 'absent'].includes(before.comparison) &&
          ['present', 'absent'].includes(a.comparison)
        )
          fail(
            `Assertion ${a.id} draft revision cannot replace a data predicate with presence/absence.`,
            { code: 'protected_expectation' },
          );
        record(edit.op, a.id, before, a);
        break;
      }
      case 'revise_manual_expected': {
        const baseline =
          base.plan.cases.find((c) => c.id === edit.case_id) ??
          fail(`Unknown original case ${edit.case_id}.`);
        if (
          !baseline.manual ||
          !testCase(edit.case_id).manual ||
          !baseline.requirements.length ||
          (!(options.mode === 'review' && options.allowDraftExpectationRevision) &&
            !baseline.requirements.every((id) => options.authorizedRequirementChanges?.has(id)))
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
  if (scopedCases)
    for (const original of base.plan.cases.filter((c) => !scopedCases.has(c.id)))
      if (
        !isDeepStrictEqual(
          original,
          value.plan.cases.find((c) => c.id === original.id),
        )
      )
        throw new PlanEditError([
          {
            path: ['cases', original.id],
            code: 'out_of_scope_edit',
            message: `Scoped edits changed unrelated case ${original.id}.`,
          },
        ]);
  return { value, changes };
}
