import { type Action, type Assertion, type Plan, type Urs } from './schema.js';
import { requirements, unresolvedQuestions } from './urs.js';
import { assertionContractIssues } from './assertion-contract.js';

type Requirement = Urs['families'][number]['requirements'][number];
export type ObligationSource = {
  requirement_id: string;
  source: string;
  content: string | NonNullable<Requirement['table']>;
};

/** Supply authoring with executable source bindings instead of asking it to invent paths. */
export function obligationSourceCatalog(urs: Urs): ObligationSource[] {
  return requirements(urs).flatMap((requirement) => [
    {
      requirement_id: requirement.id,
      source: `${requirement.id}/statement`,
      content: requirement.statement,
    },
    ...(requirement.details ?? []).flatMap((content, index) =>
      content.trim()
        ? [
            {
              requirement_id: requirement.id,
              source: `${requirement.id}/details/${index}`,
              content,
            },
          ]
        : [],
    ),
    ...(requirement.table
      ? [
          {
            requirement_id: requirement.id,
            source: `${requirement.id}/table`,
            content: requirement.table,
          },
        ]
      : []),
  ]);
}

function resolvePointer(value: unknown, parts: string[]): unknown {
  for (const part of parts) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** Only behavior text and table content can establish an obligation, never metadata. */
function behaviorPath(requirement: Requirement | undefined, parts: string[]): unknown {
  if (!requirement) return undefined;
  const path = parts.join('/');
  if (
    !/^(?:statement|details(?:\/(?:0|[1-9]\d*))?|table(?:\/(?:columns(?:\/(?:0|[1-9]\d*))?|rows(?:\/(?:0|[1-9]\d*)(?:\/(?:0|[1-9]\d*))?)?))?)$/.test(
      path,
    )
  )
    return undefined;
  const value = resolvePointer(requirement, parts);
  if (typeof value === 'string') return value.trim() ? value : undefined;
  if (path === 'table' && requirement.table) return requirement.table;
  if (Array.isArray(value) && value.length) return value;
  return undefined;
}

function resolveObligationSource(urs: Urs, requirementId: string, source: string): unknown {
  const requirement = requirements(urs).find((item) => item.id === requirementId);
  if (source.startsWith(`${requirementId}/`))
    return behaviorPath(requirement, source.slice(requirementId.length + 1).split('/'));
  if (!source.startsWith('/')) return undefined;
  const parts = source
    .slice(1)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (parts[0] !== 'families' || parts[2] !== 'requirements') return undefined;
  const containing = resolvePointer(urs, parts.slice(0, 4)) as { id?: string } | undefined;
  if (containing?.id !== requirementId) return undefined;
  return behaviorPath(requirement, parts.slice(4));
}

/** Correct only equivalent path notation, preserving every meaning-bearing plan field. */
export function normalizeObligationSources(
  input: Plan,
  urs: Urs,
): { plan: Plan; changes: { obligation: string; before: string; after: string }[] } {
  const plan = structuredClone(input);
  const changes: { obligation: string; before: string; after: string }[] = [];
  for (const obligation of plan.obligations) {
    if (resolveObligationSource(urs, obligation.requirement_id, obligation.source) !== undefined)
      continue;
    let relative = obligation.source.trim();
    for (const separator of ['/', '.'])
      if (relative.startsWith(obligation.requirement_id + separator)) {
        relative = relative.slice(obligation.requirement_id.length + 1);
        break;
      }
    relative = relative
      .replace(/^\//, '')
      .replace(/\[(0|[1-9]\d*)\]/g, '/$1')
      .replaceAll('.', '/');
    const canonical = `${obligation.requirement_id}/${relative}`;
    if (resolveObligationSource(urs, obligation.requirement_id, canonical) === undefined) continue;
    changes.push({ obligation: obligation.id, before: obligation.source, after: canonical });
    obligation.source = canonical;
  }
  return { plan, changes };
}

export function describeAction(action: Action): string {
  switch (action.op) {
    case 'navigate':
      return `Navigate to ${action.url}`;
    case 'session':
      return `Open session for ${action.actor}`;
    case 'fill':
      return `Enter ${JSON.stringify(action.value)} in ${action.locator.value}`;
    case 'fillSecret':
      return `Enter the private ${action.binding} binding in ${action.locator.value}`;
    case 'select':
      return `Select ${JSON.stringify(action.value)} in ${action.locator.value}`;
    case 'click':
      return `Click ${action.locator.value}`;
    case 'upload':
      return `Upload ${action.path} using ${action.locator.value}`;
    case 'download':
      return `Download from ${action.locator.value} as ${action.save_as}`;
    case 'read':
      return `Read ${action.read} from ${action.locator.value} as ${action.as}`;
    case 'request':
      return `${action.method} ${action.url}; retain response as ${action.as}`;
    case 'browser':
      return `${action.command.replaceAll('_', ' ')} ${action.name}${action.url ? ` at ${action.url}` : ''}`;
    case 'dialog':
      return `Click ${action.locator.value}; expect dialog response ${action.response}; retain as ${action.as}`;
    case 'observe_download':
      return `Activate ${action.locator.value}; observe downloads for ${action.timeout_ms ?? 1000} ms as ${action.as}`;
    case 'storage':
      return `Set browser storage access to ${action.mode} for this test tab`;
  }
}
export function describeAssertion(a: Assertion): string {
  const subject = a.locator ? `${a.read} of ${a.locator.value}` : a.variable;
  return `${subject} ${a.comparison.replaceAll('_', ' ')}${a.expected === undefined ? '' : ` ${JSON.stringify(a.expected)}`}${a.tolerance === undefined ? '' : ` (tolerance ${a.tolerance})`}`;
}
export function validatePlanStructure(plan: Plan, urs: Urs): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const reqs = requirements(urs);
  const reqIds = new Set(reqs.map((r) => r.id));
  const assertionCases = new Map<string, string>();
  const cases = new Map(plan.cases.map((c) => [c.id, c]));
  const actors = new Set(plan.access.map((a) => a.id));
  const addId = (id: string) => {
    if (ids.has(id)) errors.push(`Duplicate plan ID: ${id}`);
    ids.add(id);
  };
  for (const question of plan.questions) {
    addId(question.id);
    if (question.requirement && !reqIds.has(question.requirement))
      errors.push(
        `${question.id}: question requirement must name an existing URS requirement. Tool/runtime schema problems must be repaired by authoring, not assigned as user decisions.`,
      );
    if (question.kind === 'execution_preparation') {
      const affected = question.case_ids ?? [];
      if (!affected.length)
        errors.push(`${question.id}: execution preparation must identify affected manual cases.`);
      if (new Set(affected).size !== affected.length)
        errors.push(`${question.id}: execution preparation has duplicate case IDs.`);
      for (const caseId of affected) {
        const target = cases.get(caseId);
        if (!target?.manual)
          errors.push(
            `${question.id}: execution preparation case ${caseId} must be an existing manual case.`,
          );
        else {
          if (!target.prerequisites.length)
            errors.push(
              `${question.id}: execution preparation case ${caseId} must declare its prerequisites.`,
            );
          if (question.requirement && !target.requirements.includes(question.requirement))
            errors.push(
              `${question.id}: execution preparation case ${caseId} does not cover its requirement.`,
            );
        }
      }
    }
  }
  if (plan.urs_revision !== urs.document.revision)
    errors.push('Plan does not match the URS revision.');
  const origins = new Set<string>();
  for (const origin of plan.target.allowed_origins) {
    const u = new URL(origin);
    if (
      u.origin !== origin ||
      !['http:', 'https:'].includes(u.protocol) ||
      u.username ||
      u.password
    )
      errors.push(`Invalid allowed origin: ${origin}`);
    origins.add(u.origin);
  }
  const target = new URL(plan.target.url);
  if (
    !origins.has(target.origin) ||
    target.username ||
    target.password ||
    [...target.searchParams.keys(), ...new URLSearchParams(target.hash.slice(1)).keys()].some(
      (key) => /token|password|secret|api.?key|authorization/i.test(key),
    )
  )
    errors.push('Target must be within allowed origins and contain no credentials.');
  for (const actor of plan.access) {
    addId(actor.id);
    if ((actor.mode === 'anonymous') !== (actor.state === 'signed_out'))
      errors.push(`${actor.id}: signed-out access must use anonymous mode.`);
    if (actor.mode === 'session' && actor.state !== 'active')
      errors.push(`${actor.id}: reusable sessions require an active account.`);
    for (const other of actor.distinct_from)
      if (!actors.has(other) || other === actor.id)
        errors.push(`${actor.id}: invalid distinct account ${other}`);
  }
  for (const c of plan.cases) {
    addId(c.id);
    for (const r of c.requirements)
      if (!reqIds.has(r)) errors.push(`${c.id}: unknown requirement ${r}`);
    if (c.actor && !actors.has(c.actor)) errors.push(`${c.id}: unknown actor ${c.actor}`);
    const consumed = new Set(
      [
        c.actor,
        ...c.steps.flatMap((s) =>
          s.actions.flatMap((a) =>
            a.op === 'session'
              ? [a.actor]
              : a.op === 'fillSecret'
                ? [a.binding.split('.')[0]]
                : a.op === 'request' && a.auth_binding
                  ? [a.auth_binding.split('.')[0]]
                  : [],
          ),
        ),
      ].filter((id): id is string => Boolean(id)),
    );
    for (const actorId of consumed)
      if (!plan.access.find((a) => a.id === actorId)?.cases.includes(c.id))
        errors.push(`${c.id}: access inventory omits consumer of ${actorId}.`);
    if (c.manual) {
      if (!c.manual_procedure?.trim() || !c.manual_expected?.trim() || c.steps.length)
        errors.push(
          `${c.id}: manual case needs procedure/expected results and no executable steps.`,
        );
    } else if (!c.steps.length) errors.push(`${c.id}: automated case has no steps.`);
    const variables = new Map<string, string>();
    const profiles = new Map<string, Set<string>>([['main', new Set(['main'])]]);
    let activeProfile = 'main';
    const stepIds = new Set<string>();
    for (const step of c.steps) {
      // Execution, observations, reports, and edits identify steps by case + step.
      if (stepIds.has(step.id)) errors.push(`${c.id}: duplicate step ID ${step.id}.`);
      stepIds.add(step.id);
      for (const a of step.actions) {
        if (a.op === 'session') {
          profiles.clear();
          profiles.set('main', new Set(['main']));
          activeProfile = 'main';
        }
        if (a.op === 'browser') {
          if (a.command === 'open_profile') {
            if (profiles.has(a.name) || profiles.size >= 4)
              errors.push(
                `${c.id}/${step.id}: browser profiles must be unique; at most four may be open.`,
              );
            else {
              profiles.set(a.name, new Set(['main']));
              activeProfile = a.name;
            }
          } else if (a.command === 'select_profile' || a.command === 'restart_profile') {
            if (!profiles.has(a.name) || (a.command === 'restart_profile' && a.name === 'main'))
              errors.push(
                `${c.id}/${step.id}: ${a.command} needs an existing${a.command === 'restart_profile' ? ' persistent' : ''} browser profile.`,
              );
            else activeProfile = a.name;
          } else {
            const tabs = profiles.get(activeProfile)!;
            if (a.command === 'open_tab') {
              if (tabs.has(a.name) || tabs.size >= 8)
                errors.push(
                  `${c.id}/${step.id}: browser tabs must be unique; at most eight may be open per profile.`,
                );
              else tabs.add(a.name);
            } else if (!tabs.has(a.name))
              errors.push(`${c.id}/${step.id}: unknown browser tab ${a.name}.`);
          }
        }
        if (
          a.op === 'read' ||
          a.op === 'request' ||
          a.op === 'download' ||
          a.op === 'dialog' ||
          a.op === 'observe_download'
        ) {
          const name = a.op === 'download' ? a.save_as : a.as;
          if (name.includes('.')) errors.push(`${step.id}: variable names cannot contain dots.`);
          variables.set(name, a.op);
        }
      }
      for (const a of step.assertions) {
        addId(a.id);
        assertionCases.set(a.id, c.id);
        if (a.variable && !variables.has(a.variable.split('.')[0]))
          errors.push(`${a.id}: undefined observation variable ${a.variable}.`);
        for (const message of new Set(assertionContractIssues(a).map((issue) => issue.message)))
          errors.push(`${a.id}: ${message}`);
      }
      for (const e of step.evidence) {
        addId(e.id);
        if (e.kind === 'download' && (!e.variable || variables.get(e.variable) !== 'download'))
          errors.push(`${e.id}: download evidence needs a preceding download variable.`);
        if (e.kind === 'observation' && !step.assertions.length && !e.variable)
          errors.push(`${e.id}: observation evidence needs assertions or an observed variable.`);
        if (e.variable && !variables.has(e.variable.split('.')[0]))
          errors.push(`${e.id}: undefined evidence variable.`);
      }
      for (const a of step.actions) {
        if (a.op === 'browser' && a.url && !['open_tab', 'open_profile'].includes(a.command))
          errors.push(`${step.id}: only opening a browser tab or profile accepts a URL.`);
        if (a.op === 'navigate' || a.op === 'request' || (a.op === 'browser' && a.url)) {
          try {
            const u = new URL(a.url!, plan.target.url);
            if (
              !origins.has(u.origin) ||
              u.username ||
              u.password ||
              [...u.searchParams.keys()].some((k) =>
                /token|password|secret|api.?key|authorization/i.test(k),
              )
            )
              errors.push(`${step.id}: URL outside declared origins or contains credentials.`);
          } catch {
            errors.push(`${step.id}: invalid URL.`);
          }
        }
        if (a.op === 'session' && !actors.has(a.actor))
          errors.push(`${step.id}: unknown session actor.`);
        if (
          (a.op === 'fillSecret' || (a.op === 'request' && a.auth_binding)) &&
          !actors.has((a.op === 'fillSecret' ? a.binding : a.auth_binding!).split('.')[0]!)
        )
          errors.push(`${step.id}: secret binding must reference a declared actor.`);
        const binding =
          a.op === 'fillSecret' ? a.binding : a.op === 'request' ? a.auth_binding : undefined;
        if (binding && !/^[A-Za-z0-9][A-Za-z0-9_-]*\.(username|password|token)$/.test(binding))
          errors.push(
            `${step.id}: binding must name actor.username, actor.password, or actor.token.`,
          );
        if (a.op === 'upload' && !plan.fixtures.includes(a.path))
          errors.push(`${step.id}: uploaded file is not a declared fixture.`);
      }
    }
    if (!c.manual && !c.steps.some((s) => s.assertions.length))
      errors.push(`${c.id}: no assertions.`);
  }
  for (const actor of plan.access)
    for (const c of actor.cases)
      if (!cases.has(c)) errors.push(`${actor.id}: unknown access case ${c}`);
  for (const obligation of plan.obligations) {
    addId(obligation.id);
    if (!reqIds.has(obligation.requirement_id))
      errors.push(`${obligation.id}: unknown requirement.`);
    const source = resolveObligationSource(urs, obligation.requirement_id, obligation.source);
    if (source === undefined)
      errors.push(
        `${obligation.id}: source must point to existing text or a table in its requirement.`,
      );
    if (!obligation.assertion_ids.length && !obligation.manual_case_ids.length)
      errors.push(`${obligation.id}: unmapped obligation.`);
    for (const a of obligation.assertion_ids) {
      const c = cases.get(assertionCases.get(a) ?? '');
      if (!c || !c.requirements.includes(obligation.requirement_id))
        errors.push(`${obligation.id}: assertion ${a} does not cover its requirement.`);
    }
    for (const id of obligation.manual_case_ids) {
      const c = cases.get(id);
      if (!c?.manual || !c.requirements.includes(obligation.requirement_id))
        errors.push(`${obligation.id}: invalid manual case ${id}`);
    }
  }
  for (const req of reqs.filter((r) => r.applicable))
    if (!plan.obligations.some((o) => o.requirement_id === req.id))
      errors.push(`${req.id}: no clause coverage.`);
  for (const req of reqs.filter((r) => !r.applicable))
    if (plan.obligations.some((o) => o.requirement_id === req.id))
      errors.push(`${req.id}: inapplicable requirement has test obligations.`);
  return errors;
}
export function validatePlan(plan: Plan, urs: Urs): string[] {
  return [
    ...validatePlanStructure(plan, urs),
    ...plan.questions
      .filter((question) => question.kind !== 'execution_preparation')
      .map((question) => `${question.id}: ${question.question}`),
    ...(unresolvedQuestions(urs).length ? ['Resolve URS questions before approval.'] : []),
  ];
}
export function compilePlan(plan: Plan): Record<string, string> {
  return Object.fromEntries(
    plan.cases
      .filter((c) => !c.manual)
      .map((c) => [
        `tests/${c.id}.spec.cjs`,
        `// Generated from plan ${plan.id}. Edit the candidate plan, then regenerate.\n'use strict';\nmodule.exports = function register({ test, runtime }) {\n  test(${JSON.stringify(c.id + ' ' + c.title)}, async () => {\n    await runtime.executeCase(${JSON.stringify(c.id)}, ${JSON.stringify(c, null, 2)});\n  });\n};\n`,
      ]),
  );
}
