import { type Action, type Assertion, type Plan, type Urs } from './schema.js';
import { requirements } from './urs.js';

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
  }
}
export function describeAssertion(a: Assertion): string {
  const subject = a.locator ? `${a.read} of ${a.locator.value}` : a.variable;
  return `${subject} ${a.comparison.replaceAll('_', ' ')}${a.expected === undefined ? '' : ` ${JSON.stringify(a.expected)}`}${a.tolerance === undefined ? '' : ` (tolerance ${a.tolerance})`}`;
}
export function validatePlan(plan: Plan, urs: Urs): string[] {
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
  if (plan.urs_revision !== urs.document.revision)
    errors.push('Plan does not match the URS revision.');
  if (plan.questions.length) errors.push(...plan.questions.map((q) => `${q.id}: ${q.question}`));
  if (urs.open_questions.length) errors.push('Resolve URS questions before approval.');
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
    for (const step of c.steps) {
      addId(step.id);
      for (const a of step.actions) {
        if (a.op === 'read' || a.op === 'request' || a.op === 'download') {
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
        if (a.expected === undefined && !['present', 'absent'].includes(a.comparison))
          errors.push(`${a.id}: missing expected result.`);
        if (
          a.comparison === 'numeric' &&
          (typeof a.expected !== 'number' || a.tolerance === undefined)
        )
          errors.push(`${a.id}: numeric comparison requires expected number and tolerance.`);
        if (
          a.comparison === 'matches' &&
          (typeof a.expected !== 'string' || a.expected.length > 200)
        )
          errors.push(`${a.id}: wildcard pattern must be a string of at most 200 characters.`);
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
        if (a.op === 'navigate' || a.op === 'request') {
          try {
            const u = new URL(a.url, plan.target.url);
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
    const requirement = reqs.find((r) => r.id === obligation.requirement_id);
    let source: unknown;
    const resolvePointer = (value: unknown, parts: string[]) => {
      for (const part of parts) {
        if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
        value = (value as Record<string, unknown>)[part];
      }
      return value;
    };
    if (obligation.source.startsWith(`${obligation.requirement_id}/`))
      source = resolvePointer(
        requirement,
        obligation.source.slice(obligation.requirement_id.length + 1).split('/'),
      );
    else if (obligation.source.startsWith('/')) {
      const parts = obligation.source
        .slice(1)
        .split('/')
        .map((p) => p.replaceAll('~1', '/').replaceAll('~0', '~'));
      const containing = resolvePointer(urs, parts.slice(0, 4)) as { id?: string } | undefined;
      if (
        parts[0] === 'families' &&
        parts[2] === 'requirements' &&
        containing?.id === obligation.requirement_id
      )
        source = resolvePointer(urs, parts);
    }
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
